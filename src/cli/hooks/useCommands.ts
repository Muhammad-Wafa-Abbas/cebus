import { useCallback } from 'react';
import type { Participant, ContextLevel } from '../../core/types';
import type { Message } from '../../core/types';
import {
  getParticipants,
  addModelParticipant,
  removeParticipant,
  renameParticipant,
} from '../../core/session';
import { setContextLevel, markContextStale, getContextConfig } from '../../core/context-config';
import { invalidateGraph } from '../../orchestration/session/graph-cache.js';

interface UseCommandsParams {
  sessionId: string;
  participants: Participant[];
  handleExit: () => void;
  setCurrentView: React.Dispatch<React.SetStateAction<'chat' | 'help' | 'participants'>>;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  setParticipants: React.Dispatch<React.SetStateAction<Participant[]>>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  setContextLevelState: React.Dispatch<React.SetStateAction<ContextLevel>>;
}

/**
 * Returns a handleCommand callback for slash commands (/help, /add, /remove, etc.).
 */
export function useCommands({
  sessionId,
  participants,
  handleExit,
  setCurrentView,
  setMessages,
  setParticipants,
  setError,
  setContextLevelState,
}: UseCommandsParams): (command: string, args: string[]) => void {
  return useCallback(
    (command: string, args: string[]) => {
      switch (command.toLowerCase()) {
        case 'help':
          setCurrentView('help');
          break;

        case 'exit':
        case 'quit':
          handleExit();
          break;

        case 'clear':
          setMessages([]);
          break;

        case 'list':
        case 'participants':
          setCurrentView('participants');
          break;

        case 'back':
          setCurrentView('chat');
          break;

        case 'add':
          if (args.length >= 1 && args[0]) {
            (async () => {
              try {
                const parts = args[0]!.split(':');
                const providerId = parts[0];
                const modelId = parts[1];
                const nickname = parts[2];
                if (!providerId || !modelId) {
                  setError('Usage: /add provider:model[:nickname]');
                  return;
                }
                const { getProviderRegistry } = await import('../../providers/registry.js');
                const registry = getProviderRegistry();
                const provider = registry.get(providerId);
                if (provider) {
                  const available = await provider.isModelAvailable(modelId);
                  if (!available) {
                    setError(`Model '${modelId}' is not available from ${providerId}. Use /models to see available models.`);
                    return;
                  }
                }
                addModelParticipant(sessionId, providerId, modelId, { nickname });
                setParticipants(getParticipants(sessionId));
              } catch (err) {
                setError(err instanceof Error ? err.message : 'Failed to add model');
              }
            })();
          } else {
            setError('Usage: /add provider:model[:nickname]');
          }
          break;

        case 'remove':
          if (args.length >= 1 && args[0]) {
            const target = participants.find(
              p => p.nickname.toLowerCase() === args[0]!.toLowerCase()
            );
            if (target && target.type === 'model') {
              removeParticipant(sessionId, target.id);
              setParticipants(getParticipants(sessionId));
            } else {
              setError('Model not found');
            }
          } else {
            setError('Usage: /remove <nickname>');
          }
          break;

        case 'rename':
          if (args.length >= 2 && args[0] && args[1]) {
            const target = participants.find(
              p => p.nickname.toLowerCase() === args[0]!.toLowerCase()
            );
            if (target) {
              try {
                renameParticipant(sessionId, target.id, args[1]!);
                setParticipants(getParticipants(sessionId));
              } catch (err) {
                setError(err instanceof Error ? err.message : 'Failed to rename');
              }
            } else {
              setError('Participant not found');
            }
          } else {
            setError('Usage: /rename <old-nickname> <new-nickname>');
          }
          break;

        case 'context': {
          if (args.length === 0 || !args[0]) {
            const config = getContextConfig(sessionId);
            setError(
              `Current context level: ${config.level}. Use /context [none|minimal|full] to change.`
            );
            break;
          }
          const level = args[0].toLowerCase();
          if (level !== 'none' && level !== 'minimal' && level !== 'full') {
            setError('Invalid context level. Use: /context [none|minimal|full]');
            break;
          }
          setContextLevel(sessionId, level as ContextLevel);
          setContextLevelState(level as ContextLevel);
          invalidateGraph(sessionId);
          setError(`Context level set to: ${level}. Will apply on next message.`);
          break;
        }

        case 'refresh': {
          markContextStale(sessionId);
          setError('Context marked as stale. Will refresh on next message.');
          break;
        }

        default:
          setError(`Unknown command: /${command}`);
      }
    },
    [sessionId, participants, handleExit]
  );
}
