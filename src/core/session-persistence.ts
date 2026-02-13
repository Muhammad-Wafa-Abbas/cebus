import type { ChatSession, Participant, Message } from './types';
import {
  getSession,
  getParticipants,
  getMessages,
  getStore,
} from './session';
import { getDatabase } from '../orchestration/session/checkpointer.js';

export interface PersistedSession {
  session: ChatSession;
  participants: Participant[];
  messages: Message[];
}

export function saveSession(sessionId: string): void {
  const session = getSession(sessionId);
  if (!session) return;

  const participants = getParticipants(sessionId);
  const messages = getMessages(sessionId);
  const db = getDatabase();

  const saveAll = db.transaction(() => {
    db.prepare(
      'INSERT OR REPLACE INTO cebus_sessions (id, data) VALUES (?, ?)',
    ).run(sessionId, JSON.stringify(session));

    const upsertParticipant = db.prepare(
      'INSERT OR REPLACE INTO cebus_participants (session_id, id, data) VALUES (?, ?, ?)',
    );
    for (const p of participants) {
      upsertParticipant.run(sessionId, p.id, JSON.stringify(p));
    }

    db.prepare('DELETE FROM cebus_messages WHERE session_id = ?').run(sessionId);
    const insertMessage = db.prepare(
      'INSERT INTO cebus_messages (session_id, idx, data) VALUES (?, ?, ?)',
    );
    for (let i = 0; i < messages.length; i++) {
      insertMessage.run(sessionId, i, JSON.stringify(messages[i]));
    }
  });
  saveAll();
}

export function loadSession(sessionIdPrefix: string): string | null {
  const db = getDatabase();

  const rows = db.prepare(
    "SELECT id, data FROM cebus_sessions WHERE id LIKE ? || '%'",
  ).all(sessionIdPrefix) as Array<{ id: string; data: string }>;

  if (rows.length === 0) return null;

  if (rows.length > 1) {
    const ids = rows.map(r => r.id);
    throw new Error(
      `Multiple sessions match prefix "${sessionIdPrefix}":\n` +
        ids.map(id => `  ${id}`).join('\n') +
        '\nProvide a longer prefix to narrow the match.',
    );
  }

  const sessionRow = rows[0]!;
  const session = JSON.parse(sessionRow.data) as ChatSession;

  const participantRows = db.prepare(
    'SELECT data FROM cebus_participants WHERE session_id = ?',
  ).all(sessionRow.id) as Array<{ data: string }>;
  const participants = participantRows.map(r => JSON.parse(r.data) as Participant);

  const messageRows = db.prepare(
    'SELECT data FROM cebus_messages WHERE session_id = ? ORDER BY idx',
  ).all(sessionRow.id) as Array<{ data: string }>;
  const messages = messageRows.map(r => JSON.parse(r.data) as Message);

  const store = getStore();
  store.sessions.set(session.id, { ...session, status: 'active' });

  const participantMap = new Map<string, Participant>();
  const nicknameMap = new Map<string, string>();
  for (const p of participants) {
    participantMap.set(p.id, p);
    nicknameMap.set(p.nickname.toLowerCase(), p.id);
  }
  store.participantsBySession.set(session.id, participantMap);
  store.nicknameIndex.set(session.id, nicknameMap);
  store.messagesBySession.set(session.id, messages);

  return session.id;
}

