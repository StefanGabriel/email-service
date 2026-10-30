import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../auth.js';
import { db } from '../db.js';
import type { Prisma } from '../generated/prisma/client.js';
import { ApiError } from '../errors.js';
import { assertCompiles, render, sampleVariables, type VariableSpec } from '../render.js';
import { localeCandidates, publishedVersion } from '../send.js';
import { body } from '../validate.js';

const variableSchema = z.object({ name: z.string().min(1), required: z.boolean().default(false), sample: z.unknown().optional() });

// No defaults here, so a PATCH only touches the fields it sends.
const templateFields = z.object({
  name: z.string().min(1),
  category: z.enum(['transactional', 'marketing']),
  sender: z.string().min(1),
  defaultLocale: z.string(),
  variables: z.array(variableSchema),
});

const templateSchema = templateFields.extend({
  key: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/, 'lowercase letters, digits, dots, dashes'),
  category: templateFields.shape.category.default('transactional'),
  defaultLocale: templateFields.shape.defaultLocale.default('en'),
  variables: templateFields.shape.variables.default([]),
});

const contentSchema = z.object({
  subject: z.string().min(1),
  bodyMjml: z.string().min(1),
  bodyText: z.string().optional(),
  publish: z.boolean().default(false),
});

async function findTemplate(tenantId: string, key: string) {
  const t = await db.template.findUnique({ where: { tenantId_key: { tenantId, key } } });
  if (!t) throw new ApiError(404, 'template_not_found', `No template "${key}"`);
  return t;
}

async function senderId(tenantId: string, key: string) {
  const s = await db.sender.findUnique({ where: { tenantId_key: { tenantId, key } } });
  if (!s) throw new ApiError(404, 'sender_not_found', `No sender "${key}"`);
  return s.id;
}

export const templateRoutes = new Hono<Env>()
  .get('/templates', async (c) => {
    const templates = await db.template.findMany({
      where: { tenantId: c.get('tenantId') },
      include: { sender: true, versions: { where: { publishedAt: { not: null } }, select: { locale: true } } },
      orderBy: { key: 'asc' },
    });
    return c.json(
      templates.map((t) => ({
        key: t.key,
        name: t.name,
        category: t.category,
        sender: t.sender.key,
        defaultLocale: t.defaultLocale,
        variables: t.variables,
        publishedLocales: [...new Set(t.versions.map((v) => v.locale))].sort(),
      })),
    );
  })
  .post('/templates', async (c) => {
    const tenantId = c.get('tenantId');
    const input = await body(c, templateSchema);
    const exists = await db.template.findUnique({ where: { tenantId_key: { tenantId, key: input.key } } });
    if (exists) throw new ApiError(409, 'conflict', `Template "${input.key}" already exists`);
    const { sender, variables, ...rest } = input;
    const t = await db.template.create({
      data: { ...rest, variables: variables as Prisma.InputJsonValue, tenantId, senderId: await senderId(tenantId, sender) },
    });
    return c.json({ key: t.key }, 201);
  })
  .patch('/templates/:key', async (c) => {
    const tenantId = c.get('tenantId');
    const t = await findTemplate(tenantId, c.req.param('key'));
    const { sender, variables, ...rest } = await body(c, templateFields.partial());
    await db.template.update({
      where: { id: t.id },
      data: {
        ...rest,
        variables: variables as Prisma.InputJsonValue | undefined,
        senderId: sender ? await senderId(tenantId, sender) : undefined,
      },
    });
    return c.json({ key: t.key });
  })
  .get('/templates/:key', async (c) => {
    const t = await findTemplate(c.get('tenantId'), c.req.param('key'));
    const versions = await db.templateVersion.findMany({
      where: { templateId: t.id },
      orderBy: [{ locale: 'asc' }, { version: 'desc' }],
      select: { locale: true, version: true, subject: true, publishedAt: true, createdAt: true },
    });
    return c.json({ ...t, versions });
  })
  // Each save of a locale is a new version. `publish: true` makes it live at once.
  .put('/templates/:key/locales/:locale', async (c) => {
    const t = await findTemplate(c.get('tenantId'), c.req.param('key'));
    const locale = c.req.param('locale');
    const { publish, ...content } = await body(c, contentSchema);
    assertCompiles(content);
    const last = await db.templateVersion.findFirst({ where: { templateId: t.id, locale }, orderBy: { version: 'desc' } });
    const v = await db.templateVersion.create({
      data: { ...content, templateId: t.id, locale, version: (last?.version ?? 0) + 1, publishedAt: publish ? new Date() : null },
    });
    return c.json({ locale, version: v.version, published: !!v.publishedAt }, 201);
  })
  .get('/templates/:key/locales/:locale/versions/:version', async (c) => {
    const t = await findTemplate(c.get('tenantId'), c.req.param('key'));
    const v = await db.templateVersion.findUnique({
      where: { templateId_locale_version: { templateId: t.id, locale: c.req.param('locale'), version: Number(c.req.param('version')) } },
    });
    if (!v) throw new ApiError(404, 'not_found', 'No such version');
    return c.json(v);
  })
  // Publishing an older version is how a rollback works.
  .post('/templates/:key/locales/:locale/versions/:version/publish', async (c) => {
    const t = await findTemplate(c.get('tenantId'), c.req.param('key'));
    const where = { templateId_locale_version: { templateId: t.id, locale: c.req.param('locale'), version: Number(c.req.param('version')) } };
    const v = await db.templateVersion.findUnique({ where });
    if (!v) throw new ApiError(404, 'not_found', 'No such version');
    await db.templateVersion.update({ where, data: { publishedAt: new Date() } });
    return c.json({ locale: v.locale, version: v.version, published: true });
  })
  // Renders unsaved content, or the live version, with the given or sample variables.
  .post('/templates/:key/preview', async (c) => {
    const t = await findTemplate(c.get('tenantId'), c.req.param('key'));
    const input = await body(
      c,
      z.object({
        locale: z.string().optional(),
        variables: z.record(z.string(), z.unknown()).optional(),
        content: contentSchema.omit({ publish: true }).optional(),
      }),
    );
    const source = input.content ?? (await publishedVersion(t.id, localeCandidates(input.locale, t.defaultLocale)));
    if (!source) throw new ApiError(422, 'not_published', 'Nothing published to preview; send `content`');
    const variables = { ...sampleVariables(t.variables as VariableSpec[]), ...input.variables };
    return c.json(await render(source, variables));
  });
