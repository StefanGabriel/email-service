import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../auth.js';
import { db } from '../db.js';
import { ApiError } from '../errors.js';
import { enqueue, messageView, sendSchema } from '../send.js';
import { body } from '../validate.js';

export const sendRoutes = new Hono<Env>()
  .post('/send', async (c) => {
    const req = await body(c, sendSchema);
    const message = await enqueue(c.get('tenantId'), req, c.req.header('idempotency-key') || undefined);
    return c.json({ id: message.id, status: message.status }, 202);
  })
  .post('/send/batch', async (c) => {
    const { messages } = await body(c, z.object({ messages: z.array(sendSchema.extend({ idempotencyKey: z.string().optional() })).min(1).max(100) }));
    // Each email succeeds or fails on its own; one bad recipient does not sink the batch.
    const results = [];
    for (const { idempotencyKey, ...req } of messages) {
      try {
        const m = await enqueue(c.get('tenantId'), req, idempotencyKey);
        results.push({ id: m.id, status: m.status });
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        results.push({ error: { code: err.code, message: err.message } });
      }
    }
    return c.json({ results }, 207);
  })
  .get('/messages/:id', async (c) => {
    const m = await db.message.findFirst({ where: { id: c.req.param('id'), tenantId: c.get('tenantId') } });
    if (!m) throw new ApiError(404, 'not_found', 'No such message');
    return c.json(messageView(m));
  });
