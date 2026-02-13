/** A message in the conversation history sent to a provider for completion. */
export interface ContextMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  name?: string | undefined;
}

/** The result returned by a provider after completing a request. */
export interface CompletionResult {
  content: string;
  finishReason: 'stop' | 'length' | 'error' | 'cancelled';
  usage?:
    | {
        promptTokens: number;
        completionTokens: number;
        totalTokens: number;
      }
    | undefined;
  model: string;
}

/** Describes the capabilities of a specific model (context size, etc.). */
export interface ModelCapabilities {
  streaming: boolean;
  maxContextTokens: number;
  maxOutputTokens: number;
  functionCalling: boolean;
}

/** Metadata about an available model within a provider. */
export interface ModelInfo {
  id: string;
  displayName: string;
  defaultNickname: string;
  capabilities: ModelCapabilities;
}

/** Optional parameters for controlling completion behavior. */
export interface CompletionOptions {
  maxTokens?: number | undefined;
  temperature?: number | undefined;
  stopSequences?: string[] | undefined;
  signal?: AbortSignal | undefined;
}

/**
 * Standardized error codes returned by all providers.
 * Used by the shared error mapper to classify SDK-specific errors.
 */
export type ProviderErrorCode =
  | 'AUTH_FAILED'
  | 'RATE_LIMITED'
  | 'QUOTA_EXCEEDED'
  | 'MODEL_UNAVAILABLE'
  | 'INVALID_MODEL'
  | 'CONTEXT_TOO_LONG'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'PROVIDER_ERROR'
  | 'PROVIDER_UNAVAILABLE'
  | 'UNKNOWN';

/** A structured provider error with retry guidance. */
export interface ProviderError {
  code: ProviderErrorCode;
  message: string;
  retryable: boolean;
  retryAfterMs?: number | undefined;
  cause?: Error | undefined;
}

/** Concrete Error subclass implementing {@link ProviderError} for throw/catch usage. */
export class ProviderErrorImpl extends Error implements ProviderError {
  readonly code: ProviderErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs?: number | undefined;
  readonly cause?: Error | undefined;

  constructor(error: ProviderError) {
    super(error.message);
    this.name = 'ProviderError';
    this.code = error.code;
    this.retryable = error.retryable;
    this.retryAfterMs = error.retryAfterMs;
    this.cause = error.cause;
  }
}

/**
 * Tracks the state of a provider's SDK session (Copilot-specific).
 * Used to properly reuse sessions and send only new messages.
 */
export interface ProviderSessionState {
  /** Copilot SDK session ID */
  sessionId: string;
  /** Model this session is for */
  modelId: string;
  /** ISO timestamp of session creation */
  createdAt: string;
  /** ISO timestamp of last message */
  lastActivityAt: string;
  /** Index of last message sent to session */
  lastProcessedMessageIndex: number;
  /** Whether system context has been sent */
  contextInitialized: boolean;
}

/**
 * Cache performance metrics for observability.
 * Populated from provider response usage data.
 */
export interface CacheMetrics {
  /** Tokens read from cache (cost savings) */
  cacheReadTokens: number;
  /** Tokens written to cache (cache miss) */
  cacheWriteTokens: number;
  /** Tokens not cached (new content after breakpoint) */
  uncachedTokens: number;
  /** Calculated cache hit rate (0-1) */
  cacheHitRate: number;
  /** Estimated tokens saved vs stateless mode */
  totalTokensSaved: number;
}

/**
 * Session state for Anthropic provider.
 * Uses prompt caching - no true server-side session.
 */
export interface AnthropicSessionState extends ProviderSessionState {
  /** Provider identifier */
  providerId: 'anthropic';
  /** Cache performance metrics from last request */
  cacheMetrics: CacheMetrics | null;
  /** Whether minimum token threshold met for caching */
  cachingEnabled: boolean;
  /** Model-specific minimum cacheable tokens */
  minCacheableTokens: number;
}

/**
 * Session state for OpenAI provider.
 * Uses Responses API with server-side state storage.
 */
export interface OpenAISessionState extends ProviderSessionState {
  /** Provider identifier */
  providerId: 'openai';
  /** Response ID from last request - used for linking */
  previousResponseId: string | null;
  /** Whether store: true is enabled */
  serverStateEnabled: boolean;
}

/**
 * Session state for Gemini provider.
 * Uses Interactions API with server-side history storage.
 */
export interface GeminiSessionState extends ProviderSessionState {
  /** Provider identifier */
  providerId: 'gemini';
  /** Interaction ID from last request - used for linking */
  previousInteractionId: string | null;
  /** Whether interactions are being stored (55 days paid, 1 day free) */
  interactionStorageEnabled: boolean;
}

/**
 * Union type for all provider session states.
 * Discriminated by providerId field.
 */
export type ProviderSessionStateUnion =
  | AnthropicSessionState
  | OpenAISessionState
  | GeminiSessionState;

/**
 * Common interface that all AI provider adapters must implement.
 * Handles model discovery, completion (streaming and non-streaming),
 * and request lifecycle management.
 */
export interface ProviderAdapter {
  readonly id: string;
  readonly displayName: string;
  isAvailable(): Promise<boolean>;
  initialize(): Promise<void>;
  dispose(): Promise<void>;
  listModels(): Promise<ModelInfo[]>;
  isModelAvailable(modelId: string): Promise<boolean>;
  streamCompletion(
    modelId: string,
    messages: ContextMessage[],
    onToken: (token: string) => void,
    options?: CompletionOptions
  ): Promise<CompletionResult>;
  complete(
    modelId: string,
    messages: ContextMessage[],
    options?: CompletionOptions
  ): Promise<CompletionResult>;
  cancelRequest(requestId: string): void;
}

/** Registry for discovering and accessing provider adapters by ID. */
export interface ProviderRegistry {
  register(adapter: ProviderAdapter): void;
  get(providerId: string): ProviderAdapter | undefined;
  getAll(): ProviderAdapter[];
  getAvailable(): Promise<ProviderAdapter[]>;
  findProviderForModel(modelId: string): Promise<ProviderAdapter | undefined>;
}
