import { config } from './config.js';
import { decryptJson } from './crypto.js';
import { db } from './db.js';
import type { Connection, Message } from './generated/prisma/client.js';
import { createProvider } from './providers/index.js';
import { PermanentProviderError } from './providers/types.js';

const BATCH = 20;
const STUCK_AFTER_MS = 10 * 60_000;

// Exponential backoff: 30s, 1m, 2m, 4m, 8m ...
export const backoffMs = (attempt: number) => 30_000 * 2 ** (attempt - 1);

// The preferred connection, then its fallbacks in order, without loops.
export async function connectionChain(firstId: string): Promise<Connection[]> {
  const chain: Connection[] = [];
  const seen = new Set<string>();
  let id: string | null = firstId;
  while (id && !seen.has(id)) {
    seen.add(id);
    const conn: Connection | null = await db.connection.findUnique({ where: { id } });
    if (!conn) break;
    chain.push(conn);
    id = conn.fallbackId;
  }
  return chain;
}

async function underDailyLimit(conn: Connection): Promise<boolean> {
  if (conn.dailyLimit == null) return true;
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const sent = await db.message.count({ where: { connectionId: conn.id, status: 'sent', sentAt: { gte: since } } });
  return sent < conn.dailyLimit;
}

async function claim(): Promise<Message[]> {
  // SKIP LOCKED lets several workers share the queue without sending twice.
  return db.$queryRaw<Message[]>`
    UPDATE "Message" SET status = 'sending', "nextAttemptAt" = now()
    WHERE id IN (
      SELECT id FROM "Message"
      WHERE (status = 'queued' AND "nextAttemptAt" <= now())
         OR (status = 'sending' AND "nextAttemptAt" < now() - make_interval(secs => ${STUCK_AFTER_MS / 1000}))
      ORDER BY "nextAttemptAt"
      LIMIT ${BATCH}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *`;
}

export async function deliver(message: Message): Promise<void> {
  const errors: string[] = [];
  let permanentOnly = true;

  for (const conn of await connectionChain(message.preferredConnectionId)) {
    if (!(await underDailyLimit(conn))) {
      errors.push(`${conn.name}: daily limit reached`);
      permanentOnly = false;
      continue;
    }
    try {
      const provider = createProvider(conn.type, decryptJson(conn.encryptedCredentials));
      const result = await provider.send({
        messageId: message.id,
        from: { email: message.fromEmail, name: message.fromName },
        to: { email: message.toEmail, name: message.toName },
        replyTo: message.replyTo,
        subject: message.subject,
        html: message.html,
        text: message.text,
        tags: message.tags,
      });
      await db.message.update({
        where: { id: message.id },
        data: {
          status: 'sent',
          sentAt: new Date(),
          connectionId: conn.id,
          providerMessageId: result.providerMessageId,
          attempts: { increment: 1 },
          lastError: errors.length ? errors.join('; ') : null,
        },
      });
      return;
    } catch (err) {
      if (!(err instanceof PermanentProviderError)) permanentOnly = false;
      errors.push(`${conn.name}: ${(err as Error).message}`);
    }
  }

  const attempts = message.attempts + 1;
  const giveUp = permanentOnly || attempts >= config.maxAttempts;
  await db.message.update({
    where: { id: message.id },
    data: {
      attempts,
      status: giveUp ? 'failed' : 'queued',
      nextAttemptAt: new Date(Date.now() + backoffMs(attempts)),
      lastError: errors.join('; ').slice(0, 2000) || 'No connection available',
    },
  });
}

export async function runOnce(): Promise<number> {
  const batch = await claim();
  await Promise.all(batch.map(deliver));
  return batch.length;
}

export function startWorker(): () => void {
  let stopped = false;
  const loop = async () => {
    while (!stopped) {
      try {
        // Keep draining while there is work; otherwise wait for the next tick.
        if ((await runOnce()) === BATCH) continue;
      } catch (err) {
        console.error('[postbox:worker]', err);
      }
      await new Promise((r) => setTimeout(r, config.workerIntervalMs));
    }
  };
  void loop();
  return () => {
    stopped = true;
  };
}
