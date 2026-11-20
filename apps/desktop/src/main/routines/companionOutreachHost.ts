import { and, desc, eq, inArray, isNull, like } from 'drizzle-orm';
import { getDbClient } from '../localDb/client/current.js';
import { botSessionLinks, messages, sessions } from '../localDb/schema.js';
import { formatCompanionOutreachNote } from './companionOutreachNote.js';

const outreachPrefix = 'companion-outreach:';

export async function readOutreachConversation(sessionId: string, botId?: string) {
  const db = getDbClient().drizzle;
  const [session] = await db.select({
    status: sessions.status, userSendAt: sessions.userSendAt, clearedAt: sessions.clearedAt,
  }).from(sessions).where(and(eq(sessions.id, sessionId), eq(sessions.source, 'bot'))).limit(1);
  const linkedSessions = botId ? db.select({ id: botSessionLinks.sessionId }).from(botSessionLinks)
    .where(eq(botSessionLinks.botId, botId)) : undefined;
  const rows = session ? await db.select({ createdAt: messages.createdAt, content: messages.content, clientId: messages.clientId })
    .from(messages).where(and(linkedSessions ? inArray(messages.sessionId, linkedSessions) : eq(messages.sessionId, sessionId), eq(messages.role, 'assistant'),
      like(messages.clientId, outreachPrefix + '%'), isNull(messages.rewindAt)))
    .orderBy(desc(messages.createdAt)).limit(32) : [];
  return { session, rows };
}

export async function readCompanionOutreachNote(sessionId: string): Promise<string | null> {
  const { session, rows } = await readOutreachConversation(sessionId);
  if (session?.status !== 'active') return null;
  return formatCompanionOutreachNote(rows, Date.now(), session.clearedAt);
}

export async function publishCompanionOutreach(input: {
  routine: import('@cindy/maker-scheduler').Routine;
  runId: string;
  targetSessionId: string;
  clientId: string;
  text: string;
  assertCurrent(): void;
}) {
  const { createMessage } = await import('../localDb/ipc/messages.js');
  const { captureDataOwnerBroadcastScope } = await import('../device-link/broadcast-tap.js');
  input.assertCurrent();
  const scope = captureDataOwnerBroadcastScope();
  const beforePublish = async () => {
    input.assertCurrent();
    const [link] = await getDbClient().drizzle.select({ sessionId: botSessionLinks.sessionId })
      .from(botSessionLinks).innerJoin(sessions, eq(sessions.id, botSessionLinks.sessionId))
      .where(and(eq(botSessionLinks.botId, input.routine.botId), eq(botSessionLinks.role, 'canonical'),
        eq(botSessionLinks.sessionId, input.targetSessionId), isNull(botSessionLinks.archivedAt),
        eq(sessions.status, 'active'))).limit(1);
    if (!link) throw new Error('Companion outreach target changed');
    input.assertCurrent();
  };
  const saved = await createMessage(input.targetSessionId, {
    clientId: input.clientId,
    role: 'assistant',
    content: input.text,
    agentKind: 'pi',
    agentMeta: { origin: { kind: 'scheduler', scheduleId: `routine-${input.routine.id}`,
      scheduleName: input.routine.name, runId: input.runId } },
  }, { broadcastOwnerScope: scope, beforePublish });
  return { messageId: saved.id };
}
