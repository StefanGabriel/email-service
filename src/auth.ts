import { createMiddleware } from 'hono/factory';
import { hashApiKey } from './crypto.js';
import { db } from './db.js';
import { ApiError } from './errors.js';

export type Env = { Variables: { tenantId: string } };

export const requireApiKey = createMiddleware<Env>(async (c, next) => {
  const header = c.req.header('authorization') ?? '';
  const key = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!key) throw new ApiError(401, 'unauthorized', 'Send your API key as "Authorization: Bearer pbx_..."');
  const apiKey = await db.apiKey.findUnique({ where: { hash: hashApiKey(key) } });
  if (!apiKey || apiKey.revokedAt) throw new ApiError(401, 'unauthorized', 'Unknown or revoked API key');
  c.set('tenantId', apiKey.tenantId);
  // Fire and forget: a failed timestamp update must not fail the request.
  db.apiKey.update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  await next();
});
