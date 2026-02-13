import type { Participant, ContextLevel, ChatMode } from '../../core/types.js';
import { ORCHESTRATOR_AGENT_ID, type TeamConfig, type AgentProfile, type ProviderConfig, type ConversationMode, type OrchestratorMiddlewareConfig } from '../types.js';
import { getDefaultSystemPrompt, getModePrompt, getTierPrompt } from '../config/defaults.js';
import { getModelTier } from '../../core/model-tiers.js';
import {
  getSession,
  getParticipants,
  getModelParticipants,
} from '../../core/session.js';
import { getContextPromptByLevel } from '../../core/project-context.js';
import { getContextConfig, isContextStale, markContextFresh } from '../../core/context-config.js';
import { getRoleTemplate } from '../../core/role-templates.js';

export interface SessionConfigResult {
  readonly teamConfig: TeamConfig;
  readonly agentToParticipant: Map<string, string>;
}

/**
 * Sanitize a nickname to alphanumeric-hyphen format for AgentProfile IDs.
 */
export function sanitizeAgentId(nickname: string): string {
  return nickname
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 32) || 'agent';
}

/**
 * Resolve provider config from a participant's providerId.
 */
function resolveProvider(providerId: string): ProviderConfig {
  const type = (['openai', 'anthropic', 'gemini', 'ollama', 'copilot'] as const)
    .find(t => providerId.startsWith(t));

  return { type: type ?? 'openai' };
}

/**
 * Build system prompt with participant info and project context.
 */
function buildSystemPrompt(
  sessionId: string,
  participants: Participant[],
  agentNickname: string,
  contextLevel: ContextLevel,
  options?: { workingDir?: string; systemPrompt?: string },
): string {
  const systemPrompt = options?.systemPrompt ?? getDefaultSystemPrompt();

  // Participant info
  const participantInfo = participants
    .filter(p => p.type === 'model')
    .map(p => `- @${p.nickname}: ${p.displayName}`)
    .join('\n');

  // Project context (if stale)
  let projectContext = '';
  if (isContextStale(sessionId)) {
    try {
      const workingDir = options?.workingDir ?? process.cwd();
      projectContext = getContextPromptByLevel(workingDir, contextLevel);
      markContextFresh(sessionId);
    } catch {
      // Ignore errors getting project context
    }
  }

  // Folder access restrictions based on user consent
  let toolRestriction = '';
  if (contextLevel === 'none') {
    toolRestriction = '\n\n## Tool Restrictions\n- You are in CHAT-ONLY mode. The user declined folder access.\n- Do NOT use any file-system tools (view, edit, grep_search, list_dir, shell, etc.).\n- Do NOT read, list, browse, or access any files or directories on the user\'s machine.\n- If the user asks you to read files or run commands, politely explain that folder access was not granted and suggest they restart with folder access enabled.';
  } else {
    const workingDir = options?.workingDir ?? process.cwd();
    toolRestriction = `\n\n## Tool Restrictions\n- You may ONLY access files within the project folder and its subfolders: ${workingDir}\n- Do NOT access, read, list, or browse any files or directories OUTSIDE that folder.\n- If the user asks you to access paths outside the project folder, politely explain that access is restricted to the project directory only.`;
  }

  // Platform hint — helps SDK-native agents (Copilot) use the correct shell
  const platformHint = process.platform === 'win32'
    ? '\n\n## Platform\n- OS: Windows\n- Shell: Use `cmd.exe` or `powershell.exe` for shell commands. Do NOT use `pwsh` or `bash` — they may not be installed.'
    : '';

  return `${systemPrompt}\n\nParticipants in this chat:\n${participantInfo}\n\nYou are: @${agentNickname}${toolRestriction}${platformHint}${projectContext ? `\n\n${projectContext}` : ''}`;
}

/**
 * Map ChatMode to orchestration ConversationMode.
 * role_based uses sequential routing but adds role instructions to agents.
 */
function chatModeToConversationMode(chatMode: ChatMode | undefined): ConversationMode {
  switch (chatMode) {
    case 'free_chat':
      return 'free_chat';
    case 'tag_only':
      return 'tag_only';
    case 'role_based':
      return 'sequential';
    case 'sequential':
    default:
      return 'sequential';
  }
}

/**
 * Build a TeamConfig + identity map from a session's participants.
 */
export function buildSessionConfig(
  sessionId: string,
  options?: { workingDir?: string; systemPrompt?: string },
): SessionConfigResult {
  const session = getSession(sessionId);
  const chatMode = session?.chatMode;
  const participants = getParticipants(sessionId);
  const modelParticipants = getModelParticipants(sessionId);
  const agentToParticipant = new Map<string, string>();
  const usedIds = new Set<string>();

  const contextLevel = getContextConfig(sessionId).level;
  const workingDir = options?.workingDir ?? process.cwd();

  // Determine orchestrator participant ID (if any) so we can exclude it from regular agents
  const orchestratorParticipantId = session?.orchestratorConfig?.participantId;

  // Map orchestrator agent ID → participant ID so stream events resolve
  if (orchestratorParticipantId) {
    agentToParticipant.set(ORCHESTRATOR_AGENT_ID, orchestratorParticipantId);
  }

  // Filter out the orchestrator participant — it's not a regular agent
  const agentParticipants = orchestratorParticipantId
    ? modelParticipants.filter(p => p.id !== orchestratorParticipantId)
    : modelParticipants;

  const agents: AgentProfile[] = agentParticipants.map(p => {
    let agentId = sanitizeAgentId(p.nickname);

    // Ensure unique agent IDs
    if (usedIds.has(agentId)) {
      let counter = 2;
      while (usedIds.has(`${agentId}-${counter}`)) counter++;
      agentId = `${agentId}-${counter}`;
    }
    usedIds.add(agentId);

    // Map agentId → participantId
    agentToParticipant.set(agentId, p.id);

    const instructions = buildSystemPrompt(sessionId, participants, p.nickname, contextLevel, options);

    // Role-based mode: inject role instructions and skills
    let roleInstructions = '';
    let roleSkills: string[] = [];
    let roleName = `AI assistant (${p.displayName})`;

    if (chatMode === 'role_based' && p.role) {
      const template = getRoleTemplate(p.role);
      if (template) {
        roleInstructions = `\n\n## Your Role: ${template.label}\n${template.instructions}`;
        roleSkills = [...template.skills];
        roleName = `${template.label} (${p.displayName})`;
      }
    }

    // Mode-specific instructions (same for all agents in the session)
    const modePrompt = chatMode ? getModePrompt(chatMode) : '';
    const modeSection = modePrompt ? `\n\n## Chat Mode\n${modePrompt}` : '';

    // Tier-specific model guidance (per-agent based on model tier)
    const tier = getModelTier(p.modelId ?? '');
    const tierPrompt = getTierPrompt(tier);
    const tierSection = tierPrompt ? `\n\n## Model Guidance\n${tierPrompt}` : '';

    // Folder access: none → no tools, no paths; otherwise → tools allowed, sandboxed to workingDir
    const folderAccess = contextLevel === 'none'
      ? { availableTools: [] as string[], allowedPaths: [] as string[] }
      : { allowedPaths: [workingDir] };

    // Copilot session ID for zero-cost resume
    const copilotSessionId = p.providerSessionState?.sessionId;

    return {
      id: agentId,
      name: p.displayName,
      role: roleName,
      instructions: [instructions + roleInstructions + modeSection + tierSection],
      ...(roleSkills.length > 0 ? { skills: roleSkills } : {}),
      ...(p.modelId ? { model: p.modelId } : {}),
      ...(p.providerId ? { provider: resolveProvider(p.providerId) } : {}),
      ...folderAccess,
      ...(copilotSessionId ? { copilotSessionId } : {}),
    };
  });

  // Build orchestrator middleware config when enabled and not tag_only
  let orchestrator: OrchestratorMiddlewareConfig | undefined;
  const orchestratorConfig = session?.orchestratorConfig;
  if (orchestratorConfig?.enabled && chatMode !== 'tag_only') {
    orchestrator = {
      model: orchestratorConfig.modelId,
      provider: resolveProvider(orchestratorConfig.providerId),
      maxRounds: orchestratorConfig.maxRounds ?? 5,
    };
  }

  const teamConfig: TeamConfig = {
    teamId: `session-${sessionId.substring(0, 8)}`,
    mission: 'Multi-model group chat',
    orchestrationMode: 'deterministic',
    conversationMode: chatModeToConversationMode(chatMode),
    agents,
    ...(orchestrator ? { orchestrator } : {}),
  };

  return { teamConfig, agentToParticipant };
}

/**
 * Compute a hash of model participant IDs to detect changes.
 */
export function participantHash(sessionId: string): string {
  const session = getSession(sessionId);
  const models = getModelParticipants(sessionId);
  const contextLevel = getContextConfig(sessionId).level;
  const chatMode = session?.chatMode ?? 'sequential';
  const orchestratorSpec = session?.orchestratorConfig?.enabled
    ? `${session.orchestratorConfig.providerId}:${session.orchestratorConfig.modelId}:${session.orchestratorConfig.maxRounds ?? 5}`
    : 'none';
  return models
    .map(p => `${p.id}:${p.providerId}:${p.modelId}:${p.role ?? ''}`)
    .sort()
    .join('|') + `|ctx:${contextLevel}|mode:${chatMode}|sv:${orchestratorSpec}`;
}
