import type { MentionResult, ParsedMention, Participant } from './types';

export interface ParserContext {
  participants: Participant[];
  enableNaturalDetection?: boolean | undefined;
}

const NATURAL_PATTERNS = [
  /^(?:hey|hi|hello|yo)\s+(\w+)[,:]?\s*/i,
  /^(\w+)[,:]?\s+(?:what|how|why|can|could|would|please|tell|explain|help)/i,
  /(?:ask(?:ing)?|to|for)\s+(\w+)$/i,
  /what\s+(?:does|do)\s+(\w+)\s+think/i,
];

function findExplicitMentions(
  content: string,
  participants: Participant[]
): ParsedMention[] {
  const mentions: ParsedMention[] = [];

  const sortedParticipants = [...participants].sort(
    (a, b) => b.nickname.length - a.nickname.length
  );

  for (const participant of sortedParticipants) {
    const escapedNickname = participant.nickname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`@(${escapedNickname})(?=\\s|$|[,.:!?])`, 'gi');

    let match;
    while ((match = pattern.exec(content)) !== null) {
      const alreadyMatched = mentions.some(
        m => match!.index >= m.startIndex && match!.index < m.endIndex
      );

      if (!alreadyMatched) {
        mentions.push({
          raw: match[0],
          participantId: participant.id,
          startIndex: match.index,
          endIndex: match.index + match[0].length,
        });
      }
    }
  }

  const atRegex = /@/g;
  let atMatch;
  while ((atMatch = atRegex.exec(content)) !== null) {
    const coveredByPass1 = mentions.some(
      m => atMatch!.index >= m.startIndex && atMatch!.index < m.endIndex
    );
    if (coveredByPass1) continue;

    const afterAt = content.slice(atMatch.index + 1);
    const wordMatch = afterAt.match(/^[\w\s.]+/);
    if (!wordMatch) continue;

    const fullText = wordMatch[0].trimEnd();
    const words = fullText.split(/\s+/);

    for (let len = words.length; len > 0; len--) {
      const candidate = words.slice(0, len).join(' ');
      const participant = resolveNickname(candidate, participants);
      if (participant) {
        const matchLength = candidate.length + 1;
        mentions.push({
          raw: content.slice(atMatch.index, atMatch.index + matchLength),
          participantId: participant.id,
          startIndex: atMatch.index,
          endIndex: atMatch.index + matchLength,
        });
        break;
      }
    }
  }

  return mentions.sort((a, b) => a.startIndex - b.startIndex);
}

function findNaturalMentions(content: string, participants: Participant[]): ParsedMention[] {
  const mentions: ParsedMention[] = [];

  for (const pattern of NATURAL_PATTERNS) {
    const match = content.match(pattern);
    if (match && match[1]) {
      const nickname = match[1];
      const participant = resolveNickname(nickname, participants);

      if (participant) {
        const nicknameIndex = content.toLowerCase().indexOf(nickname.toLowerCase());

        mentions.push({
          raw: nickname,
          participantId: participant.id,
          startIndex: nicknameIndex,
          endIndex: nicknameIndex + nickname.length,
        });

        break;
      }
    }
  }

  return mentions;
}

function resolveNickname(
  nickname: string,
  participants: Participant[]
): Participant | undefined {
  const lowerNickname = nickname.toLowerCase();

  const exactMatch = participants.find(p => p.nickname.toLowerCase() === lowerNickname);
  if (exactMatch) {
    return exactMatch;
  }

  const partialMatch = participants.find(p => p.nickname.toLowerCase().startsWith(lowerNickname));
  if (partialMatch) {
    return partialMatch;
  }

  if (lowerNickname.length >= 3) {
    const wordBoundary = new RegExp(`\\b${lowerNickname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    const displayNameMatch = participants.find(p =>
      wordBoundary.test(p.displayName)
    );
    if (displayNameMatch) {
      return displayNameMatch;
    }
  }

  return undefined;
}

function cleanMentions(content: string, mentions: ParsedMention[]): string {
  if (mentions.length === 0) {
    return content;
  }

  const sortedMentions = [...mentions].sort((a, b) => b.startIndex - a.startIndex);

  let cleaned = content;
  for (const mention of sortedMentions) {
    cleaned = cleaned.slice(0, mention.startIndex) + cleaned.slice(mention.endIndex);
  }

  return cleaned.replace(/\s+/g, ' ').trim();
}

export function parseMentions(content: string, context: ParserContext): MentionResult {
  const { participants, enableNaturalDetection = true } = context;

  const modelParticipants = participants.filter(p => p.type === 'model');

  const explicitMentions = findExplicitMentions(content, modelParticipants);

  if (explicitMentions.length > 0) {
    const targetIds = [...new Set(explicitMentions.map(m => m.participantId))];
    const cleanedContent = cleanMentions(content, explicitMentions);

    return {
      type: 'explicit',
      targetIds,
      cleanedContent,
      mentions: explicitMentions,
    };
  }

  if (enableNaturalDetection) {
    const naturalMentions = findNaturalMentions(content, modelParticipants);

    if (naturalMentions.length > 0) {
      const targetIds = [...new Set(naturalMentions.map(m => m.participantId))];

      return {
        type: 'natural',
        targetIds,
        cleanedContent: content,
        mentions: naturalMentions,
      };
    }
  }

  return {
    type: 'broadcast',
    targetIds: [],
    cleanedContent: content,
    mentions: [],
  };
}

