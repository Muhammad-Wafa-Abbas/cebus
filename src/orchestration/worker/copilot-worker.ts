import { execFileSync } from 'child_process';
import type {
  AgentProfile,
  AgentResponse,
  ApprovalResponse,
  ExecutionContext,
  MCPInitResult,
  OrchestrationLogger,
  OrchestrationStreamEvent,
  PermissionKind,
  WorkerExecutor,
} from '../types.js';
import { OrchestrationError } from '../types.js';
import { debug } from '../../core/debug-logger.js';
import { fileLink } from '../../cli/ui/terminal-link.js';

interface CopilotShutdownStats {
  totalPremiumRequests: number;
  totalApiDurationMs: number;
}

export class CopilotWorker implements WorkerExecutor {
  private client: unknown = null;
  private session: unknown = null;
  /** Stored session ID for zero-cost resume via SDK's resumeSession() */
  private sessionId: string | null = null;
  /** Number of other-agent messages already injected into prior prompts */
  private otherAgentMessagesSeen = 0;

  /** Auto-approve budget: 0=ask, -1=unlimited, N=remaining count */
  private autoApproveBudget = 0;
  /** Pending approval resolvers keyed by approvalId */
  private readonly pendingApprovals = new Map<string, (r: ApprovalResponse) => void>();
  /** Counter for generating unique approval IDs within this worker */
  private approvalCounter = 0;
  /** Mutable ref to the current onStream callback (set per execute() call) */
  private currentOnStream: ((event: OrchestrationStreamEvent) => void) | undefined;
  /** Mutable ref to the current traceId (set per execute() call) */
  private currentTraceId: string | undefined;
  /** Mutable ref to reset the idle timeout (set per execute() call) */
  private resetIdleTimeout: (() => void) | undefined;

  /** Aggregated stats from SDK session.shutdown event */
  private shutdownStats: CopilotShutdownStats | null = null;
  /** Map toolCallId → {toolName, args} so completion events can reference the original args */
  private readonly toolCallArgs = new Map<string, { toolName: string; args: Record<string, unknown> }>();

  constructor(
    _profile: AgentProfile,
    private readonly logger?: OrchestrationLogger,
  ) {}

  async execute(
    agentProfile: AgentProfile,
    message: string,
    conversationHistory: ReadonlyArray<{ role: string; content: string; name?: string | undefined }>,
    context: ExecutionContext,
    onStream: (event: OrchestrationStreamEvent) => void,
    traceId: string,
  ): Promise<AgentResponse> {
    const startTime = Date.now();
    this.logger?.workerStart(traceId, agentProfile.id);

    // Reset per-message state
    this.autoApproveBudget = 0;
    this.currentOnStream = onStream;
    this.currentTraceId = traceId;

    try {
      const session = await this.getOrCreateSession(agentProfile);

      onStream({
        type: 'start',
        agentId: agentProfile.id,
        traceId,
        ...(context.orchestratorGuidance ? { guidance: context.orchestratorGuidance } : {}),
      });

      // Build prompt with other models' responses
      // Copilot SDK only accepts a single prompt string, so we prepend
      // other agents' messages. User↔copilot history is tracked by the SDK session.
      const prompt = this.buildPromptWithHistory(message, conversationHistory, agentProfile.name, context.orchestratorGuidance);

      let fullContent = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheReadTokens = 0;
      let cacheWriteTokens = 0;
      let premiumRequests = 0;
      let resolved = false;

      const result = await new Promise<string>((resolve, reject) => {
        // Idle timeout guard — resets on every SDK event so that
        // long-running agentic sessions (multi-file creation, tool approvals)
        // don't time out while still making progress.
        let timer: ReturnType<typeof setTimeout>;
        const resetTimeout = (): void => {
          clearTimeout(timer);
          this.resetIdleTimeout = resetTimeout;
          timer = setTimeout(() => {
            if (!resolved) {
              resolved = true;
              reject(
                new OrchestrationError(
                  'TIMEOUT',
                  `Copilot worker ${agentProfile.id} idle for ${context.timeoutBudget}ms with no activity`,
                  traceId,
                ),
              );
            }
          }, context.timeoutBudget);
        };
        resetTimeout();

        // Cancellation guard
        const token = context.cancellationToken;
        if (token && typeof token.addEventListener === 'function') {
          token.addEventListener('abort', () => {
            clearTimeout(timer);
            if (!resolved) {
              resolved = true;
              reject(
                new OrchestrationError(
                  'CANCELLED',
                  `Copilot worker ${agentProfile.id} was cancelled`,
                  traceId,
                ),
              );
            }
          });
        }

        // Subscribe to streaming events
        const typedSession = session as {
          on(handler: (event: {
            type: string;
            data: Record<string, unknown>;
          }) => void): () => void;
          send(options: { prompt: string }): Promise<string>;
        };

        const unsubscribe = typedSession.on((event) => {
          if (resolved) return;

          // Any SDK event means progress — reset idle timeout
          resetTimeout();

          // Streaming delta — token by token
          if (event.type === 'assistant.message_delta') {
            const delta = event.data['deltaContent'] as string | undefined;
            if (delta) {
              fullContent += delta;
              onStream({
                type: 'token',
                agentId: agentProfile.id,
                traceId,
                token: delta,
              });
            }
          }

          // Complete message
          if (event.type === 'assistant.message') {
            const content = event.data['content'] as string | undefined;
            if (content) {
              fullContent = content;
            }
          }

          // Token usage — emitted by the SDK after each model response
          if (event.type === 'assistant.usage') {
            inputTokens = (event.data['inputTokens'] as number) ?? inputTokens;
            outputTokens = (event.data['outputTokens'] as number) ?? outputTokens;
            cacheReadTokens = (event.data['cacheReadTokens'] as number) ?? cacheReadTokens;
            cacheWriteTokens = (event.data['cacheWriteTokens'] as number) ?? cacheWriteTokens;
            premiumRequests += (event.data['cost'] as number) ?? 0;
            this.logger?.workerComplete(traceId, agentProfile.id, 0);
            debug('copilot-worker', 'sdk-usage', event.data);
          }

          // Session idle — response is done
          if (event.type === 'session.idle') {
            clearTimeout(timer);
            unsubscribe();
            if (!resolved) {
              resolved = true;
              resolve(fullContent);
            }
          }

          // Tool execution start — emit agent_activity so the UI shows what the agent is doing
          if (event.type === 'tool.execution_start') {
            const toolName = (event.data['toolName'] as string) ?? 'unknown';
            // Skip internal bookkeeping tools that add noise to the activity log
            if (!CopilotWorker.HIDDEN_TOOLS.has(toolName)) {
              // SDK uses `arguments` as the primary key for tool args
              const toolArgs = CopilotWorker.parseToolArgs(
                event.data['arguments'] ?? event.data['args'] ?? event.data['parameters'],
              );
              debug('copilot-worker', 'tool-start', { toolName, toolArgs });
              // Store args keyed by toolCallId so formatToolResult can reference them
              const callId = event.data['toolCallId'] as string | undefined;
              if (callId) {
                this.toolCallArgs.set(callId, { toolName, args: toolArgs });
              }
              const activity = CopilotWorker.formatToolActivity(toolName, toolArgs);
              onStream({
                type: 'agent_activity',
                traceId,
                agentId: agentProfile.id,
                activity,
                toolName,
                kind: 'start',
              });
            }
          }

          // Tool execution progress — update activity with progress message
          if (event.type === 'tool.execution_progress') {
            const progressMessage = (event.data['progressMessage'] ?? event.data['message']) as string | undefined;
            if (progressMessage) {
              onStream({
                type: 'agent_activity',
                traceId,
                agentId: agentProfile.id,
                activity: progressMessage,
                toolName: (event.data['toolName'] as string) ?? undefined,
                kind: 'progress',
              });
            }
          }

          // Tool execution partial result — stream intermediate output
          if (event.type === 'tool.execution_partial_result') {
            const partialOutput = event.data['partialOutput'] as string | undefined;
            if (partialOutput) {
              const trimmed = partialOutput.length > 120
                ? partialOutput.slice(0, 117) + '...'
                : partialOutput;
              onStream({
                type: 'agent_activity',
                traceId,
                agentId: agentProfile.id,
                activity: trimmed,
                toolName: undefined,
                kind: 'progress',
              });
            }
          }

          // Tool execution complete — emit result so the UI shows the outcome
          if (event.type === 'tool.execution_complete') {
            const callId = event.data['toolCallId'] as string | undefined;
            const stored = callId ? this.toolCallArgs.get(callId) : undefined;
            const toolName = stored?.toolName ?? (event.data['toolName'] as string) ?? 'unknown';
            if (callId) this.toolCallArgs.delete(callId);

            if (!CopilotWorker.HIDDEN_TOOLS.has(toolName)) {
              const success = event.data['success'] as boolean | undefined;
              const sdkResult = event.data['result'] as { content?: string; detailedContent?: string } | undefined;
              const sdkError = event.data['error'] as { message?: string; code?: string } | undefined;

              debug('copilot-worker', 'tool-complete', {
                toolName, success, result: sdkResult, error: sdkError,
              });

              const result = CopilotWorker.formatToolResult(
                toolName, success, sdkResult, sdkError, stored?.args,
              );
              onStream({
                type: 'agent_activity',
                traceId,
                agentId: agentProfile.id,
                activity: '',
                toolName,
                kind: 'complete',
                result,
              });
            }
          }

          // Error — if we already have content, treat as successful completion.
          // The Copilot SDK sometimes fires spurious errors like "missing finish_reason"
          // after the agent has already produced a full response.
          if (event.type === 'session.error') {
            clearTimeout(timer);
            unsubscribe();
            if (!resolved) {
              resolved = true;
              const errMsg = (event.data['message'] as string) ?? 'Unknown Copilot error';
              if (fullContent.length > 0) {
                this.logger?.workerError(traceId, agentProfile.id, `Non-fatal session.error (content preserved): ${errMsg}`);
                resolve(fullContent);
              } else {
                reject(
                  new OrchestrationError(
                    'WORKER_EXECUTION',
                    `Copilot error: ${errMsg}`,
                    traceId,
                  ),
                );
              }
            }
          }
        });

        // Send the message (with history context prepended)
        typedSession.send({ prompt }).catch((err: unknown) => {
          clearTimeout(timer);
          unsubscribe();
          if (!resolved) {
            resolved = true;
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        });
      });

      fullContent = result;

      const latencyMs = Date.now() - startTime;
      this.logger?.workerComplete(traceId, agentProfile.id, latencyMs);

      const hasUsage = inputTokens > 0 || outputTokens > 0;
      const tokenUsage = hasUsage
        ? {
            inputTokens,
            outputTokens,
            ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
            ...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
            ...(premiumRequests > 0 ? { premiumRequests } : {}),
          }
        : undefined;

      onStream({
        type: 'complete',
        agentId: agentProfile.id,
        traceId,
        content: fullContent,
        ...(tokenUsage ? { tokenUsage } : {}),
      });

      return {
        agentId: agentProfile.id,
        agentName: agentProfile.name,
        content: fullContent,
        toolInvocations: [],
        ...(tokenUsage ? { tokenUsage } : {}),
      };
    } catch (err) {
      // Clear any pending approvals on failure
      this.clearPendingApprovals();

      const latencyMs = Date.now() - startTime;
      const errorMsg =
        err instanceof Error ? err.message : 'Unknown Copilot worker error';
      this.logger?.workerError(traceId, agentProfile.id, errorMsg);

      const errorCode = err instanceof OrchestrationError ? err.code : 'WORKER_EXECUTION';

      onStream({
        type: 'error',
        agentId: agentProfile.id,
        traceId,
        error: {
          code: errorCode,
          message: errorMsg,
          agentId: agentProfile.id,
          recoverable: errorCode !== 'CANCELLED',
        },
      });

      throw new OrchestrationError(
        errorCode,
        `Copilot worker ${agentProfile.id} failed after ${latencyMs}ms: ${errorMsg}`,
        traceId,
        err instanceof Error ? err : undefined,
      );
    } finally {
      this.currentOnStream = undefined;
      this.currentTraceId = undefined;
      this.resetIdleTimeout = undefined;
    }
  }

  async initializeMCP(
    _agentProfile: AgentProfile,
  ): Promise<MCPInitResult> {
    return {
      serverId: 'copilot-native',
      status: 'connected',
      toolCount: 0,
    };
  }

  /**
   * Get the stored Copilot session ID for persistence across restarts.
   * Returns null if no session has been created yet.
   */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Set a previously stored session ID for resumption on next execute().
   */
  setSessionId(id: string): void {
    this.sessionId = id;
  }

  /**
   * Get aggregated stats from the SDK's session.shutdown event.
   * Returns null if no shutdown event has been received yet.
   */
  getShutdownStats(): CopilotShutdownStats | null {
    return this.shutdownStats;
  }

  async dispose(): Promise<void> {
    if (this.session) {
      try {
        await (this.session as { destroy(): Promise<void> }).destroy();
      } catch (error) {
        debug('copilot-worker', 'session-destroy-failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.session = null;
    }
    if (this.client) {
      try {
        await (this.client as { close(): Promise<void> }).close();
      } catch (error) {
        debug('copilot-worker', 'client-close-failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.client = null;
    }
  }

  /**
   * Resolve a pending approval request from the CLI.
   */
  resolveApproval(approvalId: string, response: ApprovalResponse): void {
    const resolver = this.pendingApprovals.get(approvalId);
    if (!resolver) return;
    this.pendingApprovals.delete(approvalId);

    // User responded — reset idle timeout so the SDK has a fresh window
    this.resetIdleTimeout?.();

    // Update auto-approve budget based on response
    if (response.approved && response.budget !== 1) {
      // budget -1 = unlimited, N > 1 = remaining count (subtract 1 for the current approval)
      this.autoApproveBudget = response.budget === -1 ? -1 : Math.max(0, response.budget - 1);
    }

    resolver(response);
  }

  /**
   * Clear all pending approvals (e.g. on timeout/error).
   * Resolves them as denied so the SDK doesn't hang.
   */
  private clearPendingApprovals(): void {
    for (const [, resolver] of this.pendingApprovals) {
      resolver({ approved: false, budget: 0 });
    }
    this.pendingApprovals.clear();
  }

  /**
   * Map SDK permission kind string to our PermissionKind type.
   */
  private static mapPermissionKind(kind: string): PermissionKind {
    switch (kind) {
      case 'shell':
      case 'command':
        return 'shell';
      case 'write':
      case 'file-write':
      case 'create-directory':
        return 'write';
      case 'read':
      case 'file-read':
        return 'read';
      case 'mcp':
        return 'mcp';
      case 'url':
      case 'fetch':
        return 'url';
      default:
        return 'write'; // conservative default
    }
  }

  /**
   * Format a tool execution into a human-readable activity string.
   * File paths are wrapped in OSC 8 hyperlinks for clickable terminal support.
   */
  /** Tools that are internal bookkeeping — suppress from the activity log. */
  private static readonly HIDDEN_TOOLS = new Set(['report_intent']);

  private static formatToolActivity(toolName: string, args: Record<string, unknown>): string {
    const pathArg = CopilotWorker.extractPathArg(args);
    const basename = pathArg ? pathArg.split(/[/\\]/).pop() ?? pathArg : undefined;
    const displayName = basename && pathArg ? fileLink(basename, pathArg) : basename;

    switch (toolName) {
      case 'read_file':
      case 'view':
      case 'cat':
        return displayName ? `Read ${displayName}` : 'Reading file';
      case 'edit_file':
      case 'replace':
      case 'patch':
        return displayName ? `Editing ${displayName}` : 'Editing file';
      case 'create_file':
      case 'write_file':
        return displayName ? `Creating ${displayName}` : 'Creating file';
      case 'delete_file':
      case 'remove':
        return displayName ? `Deleting ${displayName}` : 'Deleting file';
      case 'shell':
      case 'powershell':
      case 'bash':
      case 'terminal':
      case 'run_command': {
        const cmd = (args['command'] ?? args['cmd'] ?? args['script']) as string | undefined;
        if (!cmd) return 'Running command';
        const trimmed = cmd.length > 80 ? cmd.slice(0, 77) + '...' : cmd;
        return `Running: ${trimmed}`;
      }
      case 'stop_powershell':
      case 'stop_shell':
      case 'stop_bash':
        return 'Stopping command';
      case 'list_directory':
      case 'ls':
        return displayName ? `Listing ${displayName}` : 'Listing directory';
      case 'glob':
      case 'find_files':
      case 'find': {
        const pattern = (args['pattern'] ?? args['glob'] ?? args['include']) as string | undefined;
        return pattern ? `Searching for ${pattern}` : 'Searching for files';
      }
      case 'search':
      case 'grep':
      case 'ripgrep': {
        const query = (args['query'] ?? args['pattern'] ?? args['search'] ?? args['keyword'] ?? args['text'] ?? args['regex']) as string | undefined;
        return query ? `Searching: ${query}` : 'Searching files';
      }
      case 'web_search':
      case 'bing_search': {
        const q = (args['query'] ?? args['q']) as string | undefined;
        return q ? `Searching web: ${q}` : 'Searching the web';
      }
      case 'web_fetch':
      case 'fetch_url': {
        const url = (args['url'] ?? args['href']) as string | undefined;
        return url ? `Fetching ${url}` : 'Fetching URL';
      }
      case 'think':
      case 'plan':
        return 'Thinking';
      default: {
        // Try to extract a useful detail from args for context
        const detail = CopilotWorker.extractArgDetail(args);
        // Convert snake_case to readable: "some_tool_name" → "Some tool name"
        const readable = toolName.replace(/[_-]/g, ' ');
        const label = readable.charAt(0).toUpperCase() + readable.slice(1);
        return detail ? `${label}: ${detail}` : label;
      }
    }
  }

  /**
   * Extract a file path from tool args, trying common key names first,
   * then falling back to any string value that looks like a file path.
   */
  private static extractPathArg(args: Record<string, unknown>): string | undefined {
    // Try well-known key names first (camelCase + snake_case + short names)
    for (const key of [
      'path', 'filePath', 'file_path', 'file', 'filename', 'file_name',
      'target', 'targetPath', 'target_path', 'destination',
      'uri', 'resource', 'source', 'sourcePath', 'source_path',
      'directory', 'dir', 'folder',
    ]) {
      const val = args[key];
      if (typeof val === 'string' && val.length > 0) return val;
    }
    // Fallback: scan all values for something that looks like a file path
    for (const val of Object.values(args)) {
      if (typeof val === 'string' && val.length > 0 && /[/\\]/.test(val) && /\.\w{1,10}$/.test(val)) {
        return val;
      }
    }
    return undefined;
  }

  /** Extract the most useful arg value for display in the default case. */
  private static extractArgDetail(args: Record<string, unknown>): string | undefined {
    // Try common arg names in priority order
    for (const key of ['path', 'filePath', 'file', 'filename', 'query', 'pattern', 'command', 'cmd', 'url', 'name']) {
      const val = args[key];
      if (typeof val === 'string' && val.length > 0) {
        return val.length > 60 ? val.slice(0, 57) + '...' : val;
      }
    }
    return undefined;
  }

  /**
   * Parse raw SDK arguments into a Record<string, unknown>.
   * Handles: undefined, string, object, array, and nested wrappers.
   */
  private static parseToolArgs(raw: unknown): Record<string, unknown> {
    if (raw === null || raw === undefined) return {};
    if (typeof raw === 'string') {
      // Some tools pass a JSON string
      try { return JSON.parse(raw) as Record<string, unknown>; } catch { return { path: raw }; }
    }
    if (typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
    return {};
  }

  /**
   * Format a tool completion result into a human-readable result string.
   * Uses the structured SDK result ({content, detailedContent}) and the
   * original tool args for context.
   */
  private static formatToolResult(
    toolName: string,
    success: boolean | undefined,
    sdkResult: { content?: string; detailedContent?: string } | undefined,
    sdkError: { message?: string; code?: string } | undefined,
    originalArgs?: Record<string, unknown> | undefined,
  ): string {
    // Error case
    if (success === false && sdkError?.message) {
      const msg = sdkError.message;
      return msg.length > 100 ? msg.slice(0, 97) + '...' : msg;
    }

    const content = sdkResult?.content ?? '';

    switch (toolName) {
      case 'read_file':
      case 'view':
      case 'cat': {
        // Try to count lines from content
        if (content) {
          const lines = content.split('\n').length;
          return `${lines} lines`;
        }
        return 'done';
      }
      case 'edit_file':
      case 'replace':
      case 'patch':
        return 'changes applied';
      case 'create_file':
      case 'write_file':
        return 'file created';
      case 'delete_file':
      case 'remove':
        return 'file deleted';
      case 'shell':
      case 'powershell':
      case 'bash':
      case 'terminal':
      case 'run_command': {
        // Extract exit code or short summary from content
        if (content) {
          const lines = content.trim().split('\n');
          const lastLine = lines[lines.length - 1] ?? '';
          // Check for exit code pattern
          const exitMatch = /exit\s*code\s*[=:]?\s*(\d+)/i.exec(content);
          if (exitMatch) return `exit code ${exitMatch[1]}`;
          // Show last line if short enough
          if (lastLine.length <= 80) return lastLine || 'done';
          return lastLine.slice(0, 77) + '...';
        }
        return 'done';
      }
      case 'stop_powershell':
      case 'stop_shell':
      case 'stop_bash':
        return 'stopped';
      case 'list_directory':
      case 'ls': {
        if (content) {
          const entries = content.trim().split('\n').length;
          return `${entries} entries`;
        }
        return 'done';
      }
      case 'glob':
      case 'find_files':
      case 'find': {
        if (content) {
          const files = content.trim().split('\n').filter(Boolean).length;
          return `${files} files found`;
        }
        return 'done';
      }
      case 'search':
      case 'grep':
      case 'ripgrep': {
        if (content) {
          const matches = content.trim().split('\n').filter(Boolean).length;
          return `${matches} matches`;
        }
        return 'done';
      }
      case 'web_search':
      case 'bing_search': {
        const query = originalArgs
          ? (originalArgs['query'] ?? originalArgs['q']) as string | undefined
          : undefined;
        if (content) {
          const results = content.trim().split('\n').filter(Boolean).length;
          return query ? `${results} results for "${query}"` : `${results} results`;
        }
        return 'done';
      }
      default: {
        // Use content summary if available
        if (content && content.length > 0) {
          const trimmed = content.trim();
          if (trimmed.length <= 80) return trimmed;
          return trimmed.slice(0, 77) + '...';
        }
        return 'done';
      }
    }
  }

  /**
   * Prepend only NEW other-model responses to the prompt.
   *
   * The Copilot SDK session tracks user↔copilot exchanges internally,
   * and also retains prior prompts (which already included other models'
   * responses from earlier turns). So we only inject messages the SDK
   * hasn't seen yet — i.e. other agents' responses since the last call.
   */
  private buildPromptWithHistory(
    message: string,
    history: ReadonlyArray<{ role: string; content: string; name?: string | undefined }>,
    myName: string,
    orchestratorGuidance?: string | undefined,
  ): string {
    // Filter to only other agents' responses
    const otherAgentMessages = history.filter(
      m => m.role === 'assistant' && m.name !== myName,
    );

    // Only include messages beyond what we've already injected
    const newMessages = otherAgentMessages.slice(this.otherAgentMessagesSeen);
    this.otherAgentMessagesSeen = otherAgentMessages.length;

    // Build the prompt with optional orchestrator guidance prefix
    const guidancePrefix = orchestratorGuidance
      ? `[Orchestrator Instructions]\n${orchestratorGuidance}\n\n`
      : '';

    if (newMessages.length === 0) return `${guidancePrefix}${message}`;

    const lines = newMessages.map(m => {
      const sender = m.name ?? 'Another model';
      return `[${sender}]: ${m.content}`;
    });

    return `${guidancePrefix}Other models said:\n${lines.join('\n')}\n\nUser: ${message}`;
  }

  private async getOrCreateSession(
    agentProfile: AgentProfile,
  ): Promise<unknown> {
    if (this.session) return this.session;

    // On Windows, check for PowerShell 6+ (pwsh) before starting the SDK
    if (process.platform === 'win32') {
      try {
        execFileSync('pwsh.exe', ['--version'], { stdio: 'pipe', timeout: 5000 });
      } catch {
        throw new OrchestrationError(
          'WORKER_EXECUTION',
          'GitHub Copilot SDK requires PowerShell 6+ (pwsh) on Windows, but it was not found. ' +
            'Install it with: winget install Microsoft.PowerShell — then restart your terminal.',
        );
      }
    }

    const copilotSdk = await import('@github/copilot-sdk');
    const CopilotClient =
      (copilotSdk as Record<string, unknown>)['CopilotClient'] ??
      (copilotSdk as Record<string, unknown>)['default'];

    if (!CopilotClient) {
      throw new OrchestrationError(
        'WORKER_EXECUTION',
        'Failed to import CopilotClient from @github/copilot-sdk',
      );
    }

    // Pass cwd at client level — this is where the SDK's CLI process runs,
    // and determines where built-in tools (file_editor, shell, etc.) operate.
    const workingDir = agentProfile.allowedPaths?.[0];
    const clientOptions: Record<string, unknown> = {};
    if (workingDir) {
      clientOptions['cwd'] = workingDir;
    }

    // On Windows, point SHELL to pwsh so the SDK's CLI subprocess uses PowerShell 6+.
    // We've already verified pwsh is available above.
    if (process.platform === 'win32') {
      clientOptions['env'] = {
        ...process.env,
        SHELL: 'pwsh.exe',
      };
    }

    this.client = new (CopilotClient as new (opts?: Record<string, unknown>) => Record<string, unknown>)(clientOptions);

    // Try to resume an existing session (zero token cost — server-side state)
    if (this.sessionId) {
      try {
        const resumeSession = (this.client as Record<string, unknown>)['resumeSession'] as
          ((sessionId: string) => Promise<unknown>) | undefined;
        if (resumeSession) {
          this.session = await resumeSession.call(this.client, this.sessionId);
          debug('copilot-worker', 'session-resumed', { sessionId: this.sessionId });
          return this.session;
        }
      } catch (err) {
        // Resume failed — fall through to create a new session
        debug('copilot-worker', 'session-resume-failed', {
          sessionId: this.sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
        this.sessionId = null;
      }
    }

    const systemContent = agentProfile.instructions.join('\n');

    // Determine if tools are enabled (Yes mode) or disabled (No mode)
    const toolsEnabled =
      agentProfile.availableTools === undefined ||
      agentProfile.availableTools.length > 0;

    const sessionConfig: Record<string, unknown> = {
      model: agentProfile.model ?? 'gpt-4o',
      systemMessage: { mode: 'append', content: systemContent },
      streaming: true,
    };

    // Set working directory at session level — tells the CLI's built-in tools
    // (file_editor, shell, etc.) where to operate.
    if (workingDir) {
      sessionConfig['workingDirectory'] = workingDir;
    }

    // Permission handler — async, awaited by the SDK.
    // The SDK's session._handlePermissionRequest() does `await this.permissionHandler(...)`,
    // so returning a Promise pauses tool execution until the user responds.
    //
    // read → always auto-approve; No mode → always deny;
    // Yes mode → check budget, if exhausted emit approval_required + wait for user.
    sessionConfig['onPermissionRequest'] = (
      request: { kind: string; toolName?: string; [key: string]: unknown },
    ): Promise<{ kind: string }> | { kind: string } => {
      debug('copilot-worker', 'permission-request', request);

      const permKind = CopilotWorker.mapPermissionKind(request.kind);

      // Read operations — always auto-approve
      if (permKind === 'read') {
        return { kind: 'approved' };
      }

      // No mode (tools disabled) — always deny
      if (!toolsEnabled) {
        return { kind: 'denied-by-rules' };
      }

      // Check auto-approve budget
      if (this.autoApproveBudget !== 0) {
        if (this.autoApproveBudget > 0) {
          this.autoApproveBudget--;
        }
        // -1 (unlimited) stays as-is
        return { kind: 'approved' };
      }

      // Budget exhausted — emit approval_required and wait for user response
      const approvalId = `${agentProfile.id}-perm-${++this.approvalCounter}`;
      const onStream = this.currentOnStream;
      const traceId = this.currentTraceId ?? '';

      if (!onStream) {
        // No stream callback (non-interactive mode) — deny by default for safety
        return { kind: 'denied-by-rules' };
      }

      const parameters: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(request)) {
        if (key !== 'kind') {
          parameters[key] = value;
        }
      }

      onStream({
        type: 'approval_required',
        traceId,
        agentId: agentProfile.id,
        toolName: request.toolName ?? request.kind,
        parameters,
        approvalId,
        permissionKind: permKind,
      });

      return new Promise<{ kind: string }>((resolve) => {
        this.pendingApprovals.set(approvalId, (response: ApprovalResponse) => {
          if (response.approved) {
            resolve({ kind: 'approved' });
          } else {
            resolve({ kind: 'denied-interactively-by-user' });
          }
        });
      });
    };

    // Restrict built-in tools when specified (e.g. chat-only mode)
    if (agentProfile.availableTools !== undefined) {
      sessionConfig['availableTools'] = agentProfile.availableTools;
    }

    // Sandbox filesystem access to allowed paths
    if (agentProfile.allowedPaths !== undefined) {
      sessionConfig['allowedPaths'] = agentProfile.allowedPaths;
    }

    // Configure MCP servers if any
    if (agentProfile.mcpServers && agentProfile.mcpServers.length > 0) {
      sessionConfig['mcpServers'] = agentProfile.mcpServers.map((s) => ({
        id: s.id,
        type: s.type === 'local' ? 'stdio' : 'http',
        command: s.command,
        args: s.args,
        url: s.url,
        headers: s.headers,
        env: s.env,
      }));
    }

    const createSession = (this.client as Record<string, unknown>)['createSession'] as
      ((config: Record<string, unknown>) => Promise<unknown>) | undefined;

    if (!createSession) {
      throw new OrchestrationError(
        'WORKER_EXECUTION',
        'CopilotClient.createSession is not available',
      );
    }

    this.session = await createSession.call(this.client, sessionConfig);

    // Store the session ID for future resumption
    const sessionObj = this.session as Record<string, unknown> | null;
    const newSessionId = sessionObj?.['sessionId'] ?? sessionObj?.['id'];
    if (typeof newSessionId === 'string') {
      this.sessionId = newSessionId;
      debug('copilot-worker', 'session-created', { sessionId: this.sessionId });
    }

    // Register persistent listener for session.shutdown stats and SDK compaction events
    const typedNewSession = this.session as {
      on(handler: (event: { type: string; data: Record<string, unknown> }) => void): () => void;
    };
    typedNewSession.on((event) => {
      if (event.type === 'session.shutdown') {
        this.shutdownStats = {
          totalPremiumRequests: (event.data['totalPremiumRequests'] as number) ?? 0,
          totalApiDurationMs: (event.data['totalApiDurationMs'] as number) ?? 0,
        };
        debug('copilot-worker', 'session-shutdown', this.shutdownStats);
      }

      // Forward SDK compaction lifecycle events to the stream
      if (event.type === 'session.compaction_start') {
        debug('copilot-worker', 'sdk-compaction-start', event.data);
        this.currentOnStream?.({
          type: 'compaction_status',
          traceId: this.currentTraceId ?? '',
          agentId: agentProfile.id,
          agentName: agentProfile.name,
          source: 'sdk',
          totalMessages: 0,
          windowSize: 0,
          compactedMessages: 0,
          summarized: false,
        });
      }

      if (event.type === 'session.compaction_complete') {
        debug('copilot-worker', 'sdk-compaction-complete', event.data);
        this.currentOnStream?.({
          type: 'compaction_status',
          traceId: this.currentTraceId ?? '',
          agentId: agentProfile.id,
          agentName: agentProfile.name,
          source: 'sdk',
          totalMessages: (event.data['preCompactionTokens'] as number) ?? 0,
          windowSize: (event.data['postCompactionTokens'] as number) ?? 0,
          compactedMessages: (event.data['messagesRemoved'] as number) ?? 1,
          summarized: true,
        });
      }
    });

    return this.session;
  }
}
