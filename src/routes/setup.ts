import { resolveTxt } from 'node:dns/promises';
import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../auth.js';
import { encryptJson } from '../crypto.js';
import { db } from '../db.js';
import { ApiError } from '../errors.js';
import { credentialSchemas } from '../providers/index.js';
import { body } from '../validate.js';

const connectionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('smtp'), credentials: credentialSchemas.smtp }),
  z.object({ type: z.literal('resend'), credentials: credentialSchemas.resend }),
  z.object({ type: z.literal('brevo'), credentials: credentialSchemas.brevo }),
  z.object({ type: z.literal('sendgrid'), credentials: credentialSchemas.sendgrid }),
  z.object({ type: z.literal('log'), credentials: credentialSchemas.log }),
]);

const connectionMeta = z.object({
  name: z.string().min(1),
  dailyLimit: z.number().int().positive().nullable().optional(),
  fallback: z.string().nullable().optional(), // name of another connection
});

async function connectionIdByName(tenantId: string, name: string | null | undefined) {
  if (name == null) return name;
  const conn = await db.connection.findUnique({ where: { tenantId_name: { tenantId, name } } });
  if (!conn) throw new ApiError(404, 'connection_not_found', `No connection "${name}"`);
  return conn.id;
}

const domainRecord = (name: string, token: string) => ({
  type: 'TXT',
  host: `_postbox.${name}`,
  value: `postbox-verification=${token}`,
});

export const setupRoutes = new Hono<Env>()
  // Credentials are write-only: they are never returned.
  .get('/connections', async (c) => {
    const rows = await db.connection.findMany({ where: { tenantId: c.get('tenantId') }, include: { fallback: true }, orderBy: { name: 'asc' } });
    return c.json(rows.map((r) => ({ name: r.name, type: r.type, dailyLimit: r.dailyLimit, fallback: r.fallback?.name ?? null })));
  })
  .put('/connections/:name', async (c) => {
    const tenantId = c.get('tenantId');
    const name = c.req.param('name');
    const input = await body(c, connectionSchema.and(connectionMeta.omit({ name: true })));
    const fallbackId = await connectionIdByName(tenantId, input.fallback);
    const data = {
      type: input.type,
      encryptedCredentials: encryptJson(input.credentials),
      dailyLimit: input.dailyLimit ?? null,
      fallbackId: fallbackId ?? null,
    };
    await db.connection.upsert({ where: { tenantId_name: { tenantId, name } }, create: { ...data, tenantId, name }, update: data });
    return c.json({ name, type: input.type });
  })
  .get('/domains', async (c) => {
    const rows = await db.domain.findMany({ where: { tenantId: c.get('tenantId') }, include: { defaultConnection: true }, orderBy: { name: 'asc' } });
    return c.json(
      rows.map((d) => ({
        name: d.name,
        verified: !!d.verifiedAt,
        defaultConnection: d.defaultConnection?.name ?? null,
        verificationRecord: domainRecord(d.name, d.verificationToken),
      })),
    );
  })
  .post('/domains', async (c) => {
    const tenantId = c.get('tenantId');
    const input = await body(c, z.object({ name: z.string().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i), defaultConnection: z.string().optional() }));
    const name = input.name.toLowerCase();
    const exists = await db.domain.findUnique({ where: { tenantId_name: { tenantId, name } } });
    if (exists) throw new ApiError(409, 'conflict', `Domain ${name} already exists`);
    const d = await db.domain.create({
      data: { tenantId, name, defaultConnectionId: await connectionIdByName(tenantId, input.defaultConnection) },
    });
    return c.json({ name: d.name, verified: false, verificationRecord: domainRecord(d.name, d.verificationToken) }, 201);
  })
  .patch('/domains/:name', async (c) => {
    const tenantId = c.get('tenantId');
    const input = await body(c, z.object({ defaultConnection: z.string().nullable() }));
    const d = await db.domain.findUnique({ where: { tenantId_name: { tenantId, name: c.req.param('name') } } });
    if (!d) throw new ApiError(404, 'not_found', 'No such domain');
    await db.domain.update({ where: { id: d.id }, data: { defaultConnectionId: await connectionIdByName(tenantId, input.defaultConnection) } });
    return c.json({ name: d.name });
  })
  // Looks up the TXT record shown when the domain was added.
  .post('/domains/:name/verify', async (c) => {
    const d = await db.domain.findUnique({ where: { tenantId_name: { tenantId: c.get('tenantId'), name: c.req.param('name') } } });
    if (!d) throw new ApiError(404, 'not_found', 'No such domain');
    const record = domainRecord(d.name, d.verificationToken);
    const found = await resolveTxt(record.host).then((rows) => rows.map((r) => r.join('')), () => [] as string[]);
    if (!found.includes(record.value)) {
      throw new ApiError(422, 'verification_failed', `TXT record not found yet at ${record.host}; DNS changes can take a few minutes`, { record });
    }
    await db.domain.update({ where: { id: d.id }, data: { verifiedAt: d.verifiedAt ?? new Date() } });
    return c.json({ name: d.name, verified: true });
  })
  .get('/senders', async (c) => {
    const rows = await db.sender.findMany({ where: { tenantId: c.get('tenantId') }, include: { domain: true, connection: true }, orderBy: { key: 'asc' } });
    return c.json(
      rows.map((s) => ({
        key: s.key,
        from: `${s.fromName} <${s.fromLocal}@${s.domain.name}>`,
        replyTo: s.replyTo,
        connection: s.connection?.name ?? null,
      })),
    );
  })
  .put('/senders/:key', async (c) => {
    const tenantId = c.get('tenantId');
    const key = c.req.param('key');
    const input = await body(
      c,
      z.object({
        fromName: z.string().min(1),
        fromEmail: z.email(),
        replyTo: z.email().nullable().optional(),
        connection: z.string().nullable().optional(),
      }),
    );
    const [fromLocal, domainName] = input.fromEmail.toLowerCase().split('@');
    const domain = await db.domain.findUnique({ where: { tenantId_name: { tenantId, name: domainName } } });
    if (!domain) throw new ApiError(422, 'domain_not_found', `Add and verify ${domainName} before using it in a sender`);
    const data = {
      fromName: input.fromName,
      fromLocal,
      domainId: domain.id,
      replyTo: input.replyTo ?? null,
      connectionId: (await connectionIdByName(tenantId, input.connection)) ?? null,
    };
    await db.sender.upsert({ where: { tenantId_key: { tenantId, key } }, create: { ...data, tenantId, key }, update: data });
    return c.json({ key, from: `${input.fromName} <${fromLocal}@${domainName}>` });
  })
  .get('/suppressions', async (c) => {
    return c.json(await db.suppression.findMany({ where: { tenantId: c.get('tenantId') }, select: { email: true, reason: true, createdAt: true }, orderBy: { createdAt: 'desc' } }));
  })
  .post('/suppressions', async (c) => {
    const tenantId = c.get('tenantId');
    const input = await body(c, z.object({ email: z.email(), reason: z.enum(['bounce', 'complaint', 'unsubscribe', 'manual']).default('manual') }));
    const email = input.email.toLowerCase();
    await db.suppression.upsert({ where: { tenantId_email: { tenantId, email } }, create: { tenantId, email, reason: input.reason }, update: { reason: input.reason } });
    return c.json({ email, reason: input.reason }, 201);
  })
  .delete('/suppressions/:email', async (c) => {
    await db.suppression.deleteMany({ where: { tenantId: c.get('tenantId'), email: c.req.param('email').toLowerCase() } });
    return c.body(null, 204);
  });
