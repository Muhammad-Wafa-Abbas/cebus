export type {
  // Session types
  ChatSession,
  SessionStatus,
  SessionStore,

  // Participant types
  Participant,
  ParticipantType,
  ModelConfig,

  // Message types
  Message,
  MessageType,
  MessageStatus,
  CompletionMeta,
  CompletionError,
  TokenUsage,
  FinishReason,

  // Mention types
  MentionType,
  MentionResult,
  ParsedMention,

  // Stream types
  StreamEvent,
  StreamError,
  StreamErrorCode,
} from './core/types';

export type {
  ProviderAdapter,
  ProviderRegistry,
  ProviderError,
  ProviderErrorCode,
  ModelInfo,
  ModelCapabilities,
  ContextMessage,
  CompletionResult,
  CompletionOptions,
} from './providers/types';

export { ProviderErrorImpl } from './providers/types';

export {
  // Session CRUD
  createSession,
  getSession,
  endSession,
  deleteSession,

  // Participant management
  addUserParticipant,
  addModelParticipant,
  getParticipants,
  getParticipant,
  getModelParticipants,
  getUserParticipant,
  findParticipantByNickname,
  removeParticipant,
  renameParticipant,

  // Nickname utilities
  getDefaultNickname,
  validateNickname,
  isNicknameUnique,
  generateUniqueNickname,

  // Message management
  addMessage,
  getMessages,
  getMessagesBySender,
  updateMessage,

  // Store utilities
  getStore,
  clearStore,
} from './core/session';

export {
  // Message creation
  createMessage,
  createUserMessage,
  createAssistantMessage,
  createSystemMessage,

  // Status updates
  markMessageSent,
  markMessageComplete,
  markMessageError,
  appendMessageContent,

  // Message type checks
  isModelMessage,
  isUserMessage,
  isDirectedMessage,
  isBroadcastMessage,
  isMessageForParticipant,

  // Formatting
  formatTimestamp,
  getMessageAge,
} from './core/message';

export {
  parseMentions,
} from './core/mention-parser';

export {
  compile,
  loadTeamConfig,
  validateTeamConfig,
  getOrCompileGraph,
  invalidateGraph,
  clearGraphCache,
  buildSessionConfig,
  sanitizeAgentId,
  getDefaultSystemPrompt,
  OrchestrationError,
  createPlaceholder,
  appendToken,
  finalizeResponse,
  finalizeError,
} from './orchestration/index.js';

export type {
  TeamConfig,
  CompileOptions,
  OrchestrationGraph,
  OrchestrationInput,
  OrchestrationOutput,
  OrchestrationStreamEvent,
  AgentProfile,
  SessionConfigResult,
  ImageInput,
} from './orchestration/index.js';

export { getProviderRegistry, resetProviderRegistry } from './providers/registry';

export {
  registerBuiltInProviders,
  initializeProviders,
  createOpenAIAdapter,
  createAnthropicAdapter,
  createCopilotAdapter,
  OpenAIAdapter,
  AnthropicAdapter,
  CopilotAdapter,
} from './providers';

export {
  loadConfig,
  getConfig,
} from './config';

export type { AppConfig } from './config';

export {
  NicknameSchema,
  MessageSchema,
  CompletionMetaSchema,
  ProviderConfigSchema,
  ConfigSchema,
} from './config/schema';
