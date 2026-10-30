import { z } from 'zod';
import { db } from './db.js';
import { ApiError } from './errors.js';
import { Prisma, type Message } from './generated/prisma/client.js';
import { missingVariables, render, type VariableSpec } from './render.js';

export const sendSchema = z.object({
  template: z.string().min(1),
  to: z.object({ email: z.email(), name: z.string().max(200).optional() }),
  locale: z.string().max(20).optional(),
  variables: z.record(z.string(), z.unknown()).default({}),
  // Another sender of the same tenant, by key. Never a free-typed address.
  sender: z.string().optional(),
  tags: z.array(z.string().max(100)).max(10).default([]),
});

export type SendRequest = z.infer<typeof sendSchema>;

// "ro-RO" -> ["ro-RO", "ro", <template default>]
export function localeCandidates(requested: string | undefined, fallback: string): string[] {
  const out: string[] = [];
  if (requested) {
    out.push(requested);
    const base = requested.split(/[-_]/)[0];
    if (base !== requested) out.push(base);
  }
  out.push(fallback);
  return [...new Set(out)];
}

export async function publishedVersion(templateId: string, locales: string[]) {
  for (const locale of locales) {
    const version = await db.templateVersion.findFirst({
      where: { templateId, locale, publishedAt: { not: null } },
      orderBy: { publishedAt: 'desc' },
    });
    if (version) return version;
  }
  return null;
}

export async function enqueue(tenantId: string, req: SendRequest, idempotencyKey?: string): Promise<Message> {
  if (idempotencyKey) {
    const existing = await db.message.findUnique({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey } } });
    if (existing) return existing;
  }

  const template = await db.template.findUnique({
    where: { tenantId_key: { tenantId, key: req.template } },
    include: { sender: { include: { domain: true } } },
  });
  if (!template) throw new ApiError(404, 'template_not_found', `No template "${req.template}"`);

  const sender = req.sender
    ? await db.sender.findUnique({ where: { tenantId_key: { tenantId, key: req.sender } }, include: { domain: true } })
    : template.sender;
  if (!sender) throw new ApiError(404, 'sender_not_found', `No sender "${req.sender}"`);
  if (!sender.domain.verifiedAt) {
    throw new ApiError(422, 'domain_unverified', `Domain ${sender.domain.name} is not verified yet`);
  }
  const connectionId = sender.connectionId ?? sender.domain.defaultConnectionId;
  if (!connectionId) {
    throw new ApiError(422, 'no_connection', `Sender "${sender.key}" has no connection and its domain has no default`);
  }

  const missing = missingVariables(template.variables as VariableSpec[], req.variables);
  if (missing.length) {
    throw new ApiError(422, 'missing_variables', `Missing variables: ${missing.join(', ')}`, { missing });
  }

  const version = await publishedVersion(template.id, localeCandidates(req.locale, template.defaultLocale));
  if (!version) throw new ApiError(422, 'not_published', `Template "${req.template}" has no published version`);

  const rendered = await render(version, req.variables);
  const toEmail = req.to.email.toLowerCase();

  // Bounces and complaints block everything; unsubscribes only block marketing.
  const suppression = await db.suppression.findUnique({ where: { tenantId_email: { tenantId, email: toEmail } } });
  const suppressed =
    suppression && (suppression.reason !== 'unsubscribe' || template.category === 'marketing');

  try {
    return await db.message.create({
      data: {
        tenantId,
        templateVersionId: version.id,
        idempotencyKey,
        toEmail,
        toName: req.to.name,
        fromEmail: `${sender.fromLocal}@${sender.domain.name}`,
        fromName: sender.fromName,
        replyTo: sender.replyTo,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        tags: req.tags,
        preferredConnectionId: connectionId,
        status: suppressed ? 'suppressed' : 'queued',
        lastError: suppressed ? `Recipient suppressed (${suppression.reason})` : null,
      },
    });
  } catch (err) {
    // Two requests with the same key raced; return the one that won.
    if (idempotencyKey && err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return db.message.findUniqueOrThrow({ where: { tenantId_idempotencyKey: { tenantId, idempotencyKey } } });
    }
    throw err;
  }
}

export function messageView(m: Message) {
  return {
    id: m.id,
    status: m.status,
    to: m.toEmail,
    from: m.fromEmail,
    subject: m.subject,
    attempts: m.attempts,
    error: m.lastError,
    createdAt: m.createdAt,
    sentAt: m.sentAt,
  };
}
