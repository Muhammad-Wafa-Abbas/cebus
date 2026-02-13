import type {
  BudgetConfig,
  BudgetState,
  BudgetStatus,
  TokenUsage,
  OrchestrationLogger,
} from '../types.js';

interface BudgetCheckResult {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly budgetType?: 'agent_tokens' | 'session_tokens' | 'rate_limit';
  readonly current?: number;
  readonly limit?: number;
}

const RATE_LIMIT_WINDOW_MS = 60_000; // 60 seconds

export class BudgetTracker {
  private readonly states = new Map<string, BudgetState>();

  constructor(
    private readonly config?: BudgetConfig,
    private readonly logger?: OrchestrationLogger,
  ) {}

  /**
   * Pre-flight check: can this agent execute within budget?
   */
  checkBudget(
    sessionId: string,
    agentId: string,
    traceId: string,
  ): BudgetCheckResult {
    if (!this.config) return { allowed: true };

    const state = this.getOrCreateState(sessionId);

    // Check per-agent token limit
    if (this.config.maxTokensPerAgentPerSession != null) {
      const agentUsage = state.agentTokenUsage[agentId];
      const agentTotal = agentUsage
        ? agentUsage.input + agentUsage.output
        : 0;

      if (agentTotal >= this.config.maxTokensPerAgentPerSession) {
        const result: BudgetCheckResult = {
          allowed: false,
          reason: `Agent ${agentId} exceeded per-agent token limit`,
          budgetType: 'agent_tokens',
          current: agentTotal,
          limit: this.config.maxTokensPerAgentPerSession,
        };
        this.logger?.budgetExceeded(
          traceId,
          agentId,
          'agent_tokens',
          agentTotal,
          this.config.maxTokensPerAgentPerSession,
        );
        return result;
      }

      // Warn at 80%
      const threshold = this.config.maxTokensPerAgentPerSession * 0.8;
      if (agentTotal >= threshold) {
        this.logger?.budgetWarning(
          traceId,
          agentId,
          'agent_tokens',
          agentTotal,
          this.config.maxTokensPerAgentPerSession,
        );
      }
    }

    // Check per-session token limit
    if (this.config.maxTokensPerSession != null) {
      if (state.totalTokens >= this.config.maxTokensPerSession) {
        const result: BudgetCheckResult = {
          allowed: false,
          reason: `Session ${sessionId} exceeded total token limit`,
          budgetType: 'session_tokens',
          current: state.totalTokens,
          limit: this.config.maxTokensPerSession,
        };
        this.logger?.budgetExceeded(
          traceId,
          agentId,
          'session_tokens',
          state.totalTokens,
          this.config.maxTokensPerSession,
        );
        return result;
      }
    }

    // Check rate limit (invocations per minute)
    if (this.config.maxInvocationsPerMinute != null) {
      const now = Date.now();
      const timestamps = state.invocationTimestamps[agentId] ?? [];
      const recentCount = timestamps.filter(
        (t) => now - t < RATE_LIMIT_WINDOW_MS,
      ).length;

      if (recentCount >= this.config.maxInvocationsPerMinute) {
        const result: BudgetCheckResult = {
          allowed: false,
          reason: `Agent ${agentId} exceeded rate limit (${recentCount}/${this.config.maxInvocationsPerMinute} per minute)`,
          budgetType: 'rate_limit',
          current: recentCount,
          limit: this.config.maxInvocationsPerMinute,
        };
        this.logger?.budgetExceeded(
          traceId,
          agentId,
          'rate_limit',
          recentCount,
          this.config.maxInvocationsPerMinute,
        );
        return result;
      }
    }

    this.logger?.budgetCheck(traceId, agentId, true);
    return { allowed: true };
  }

  /**
   * Post-flight: record actual token usage from LLM response.
   */
  recordUsage(
    sessionId: string,
    agentId: string,
    tokenUsage: TokenUsage,
  ): void {
    const state = this.getOrCreateState(sessionId);

    // Update agent token usage
    const existing = state.agentTokenUsage[agentId] ?? {
      input: 0,
      output: 0,
    };
    state.agentTokenUsage[agentId] = {
      input: existing.input + tokenUsage.inputTokens,
      output: existing.output + tokenUsage.outputTokens,
    };

    // Update total tokens
    state.totalTokens += tokenUsage.inputTokens + tokenUsage.outputTokens;

    // Record invocation timestamp
    if (!state.invocationTimestamps[agentId]) {
      state.invocationTimestamps[agentId] = [];
    }

    const now = Date.now();
    state.invocationTimestamps[agentId]!.push(now);

    // Clean up old timestamps (older than window)
    state.invocationTimestamps[agentId] =
      state.invocationTimestamps[agentId]!.filter(
        (t) => now - t < RATE_LIMIT_WINDOW_MS,
      );
  }

  /**
   * Get current budget status for a session.
   */
  getStatus(sessionId: string): BudgetStatus {
    const state = this.getOrCreateState(sessionId);

    const agentUsage: Record<string, TokenUsage> = {};
    for (const [agentId, usage] of Object.entries(state.agentTokenUsage)) {
      agentUsage[agentId] = {
        inputTokens: usage.input,
        outputTokens: usage.output,
      };
    }

    return {
      sessionId,
      agentUsage,
      totalTokens: state.totalTokens,
      limits: {
        perAgentPerSession:
          this.config?.maxTokensPerAgentPerSession ?? null,
        perSession: this.config?.maxTokensPerSession ?? null,
        perMinute: this.config?.maxInvocationsPerMinute ?? null,
      },
    };
  }

  private getOrCreateState(sessionId: string): BudgetState {
    let state = this.states.get(sessionId);
    if (!state) {
      state = {
        sessionId,
        agentTokenUsage: {},
        totalTokens: 0,
        invocationTimestamps: {},
      };
      this.states.set(sessionId, state);
    }
    return state;
  }
}
