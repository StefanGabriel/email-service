import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app } from '../src/app.js';
import { generateApiKey } from '../src/crypto.js';
import { db } from '../src/db.js';
import { logOutbox } from '../src/providers/log.js';
import { runOnce } from '../src/worker.js';

async function newTenant(slug: string) {
  const tenant = await db.tenant.create({ data: { slug, name: slug } });
  const { key, prefix, hash } = generateApiKey();
  await db.apiKey.create({ data: { tenantId: tenant.id, name: 'test', prefix, hash } });
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(path, {
      method,
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  };
  return { tenant, key, call };
}

type Client = Awaited<ReturnType<typeof newTenant>>;

const mjml = (inner: string) =>
  `<mjml><mj-body><mj-section><mj-column><mj-text>${inner}</mj-text></mj-column></mj-section></mj-body></mjml>`;

// A tenant with a failing primary connection, a working fallback, a verified domain and one template.
async function setupTenant(slug: string): Promise<Client> {
  const client = await newTenant(slug);
  const { call } = client;
  expect((await call('PUT', '/v1/connections/backup', { type: 'log', credentials: { quiet: true } })).status).toBe(200);
  expect(
    (await call('PUT', '/v1/connections/primary', { type: 'log', credentials: { quiet: true }, fallback: 'backup' })).status,
  ).toBe(200);
  const domain = await call('POST', '/v1/domains', { name: `${slug}.test`, defaultConnection: 'primary' });
  expect(domain.status).toBe(201);
  expect(domain.json.verificationRecord.host).toBe(`_postbox.${slug}.test`);
  await db.domain.updateMany({ where: { tenantId: client.tenant.id }, data: { verifiedAt: new Date() } });
  expect((await call('PUT', '/v1/senders/noreply', { fromName: 'App', fromEmail: `noreply@${slug}.test` })).status).toBe(200);
  expect(
    (await call('PUT', '/v1/senders/billing', { fromName: 'Billing', fromEmail: `billing@${slug}.test`, replyTo: 'help@example.org' })).status,
  ).toBe(200);
  const created = await call('POST', '/v1/templates', {
    key: 'account.verify-email',
    name: 'Verify email',
    sender: 'noreply',
    variables: [
      { name: 'name', sample: 'Ana' },
      { name: 'verifyUrl', required: true },
    ],
  });
  expect(created.status).toBe(201);
  for (const [locale, subject] of [['en', 'Confirm, {{name}}'], ['ro', 'Confirmă, {{name}}']]) {
    const v = await call('PUT', `/v1/templates/account.verify-email/locales/${locale}`, {
      subject,
      bodyMjml: mjml(`${locale}: {{name}} <a href="{{verifyUrl}}">go</a>`),
      bodyText: '{{name}} {{verifyUrl}}',
      publish: true,
    });
    expect(v.status).toBe(201);
  }
  return client;
}

const send = (client: Client, body: Record<string, unknown>, headers?: Record<string, string>) =>
  client.call('POST', '/v1/send', { template: 'account.verify-email', to: { email: 'Ana@Example.com' }, variables: { name: 'Ana', verifyUrl: 'https://x.test/v' }, ...body }, headers);

let n = 0;
let client: Client;

beforeAll(async () => {
  await db.message.deleteMany();
});

beforeEach(async () => {
  logOutbox.length = 0;
  client = await setupTenant(`t${++n}${Date.now()}`);
});

describe('send', () => {
  it('renders the closest locale and delivers through the worker', async () => {
    const res = await send(client, { locale: 'ro-RO', variables: { name: '<b>Ana</b>', verifyUrl: 'https://x.test/v' } });
    expect(res.status).toBe(202);
    expect(res.json.status).toBe('queued');

    await runOnce();
    const msg = await client.call('GET', `/v1/messages/${res.json.id}`);
    expect(msg.json.status).toBe('sent');
    expect(msg.json.to).toBe('ana@example.com');

    const sent = logOutbox.find((e) => e.messageId === res.json.id)!;
    // Subject is plain text; the HTML body escapes variables.
    expect(sent.subject).toBe('Confirmă, <b>Ana</b>');
    expect(sent.html).toContain('ro: &lt;b&gt;Ana&lt;/b&gt;');
    expect(sent.from.email).toBe(`noreply@${client.tenant.slug}.test`);
  });

  it('falls back to the template default locale', async () => {
    const res = await send(client, { locale: 'de' });
    await runOnce();
    expect(logOutbox.find((e) => e.messageId === res.json.id)?.subject).toBe('Confirm, Ana');
  });

  it('rejects missing required variables', async () => {
    const res = await send(client, { variables: { name: 'Ana' } });
    expect(res.status).toBe(422);
    expect(res.json.error.details.missing).toEqual(['verifyUrl']);
  });

  it('returns the first message for a repeated idempotency key', async () => {
    const a = await send(client, {}, { 'idempotency-key': 'order-1' });
    const b = await send(client, {}, { 'idempotency-key': 'order-1' });
    expect(b.json.id).toBe(a.json.id);
    expect(await db.message.count({ where: { tenantId: client.tenant.id } })).toBe(1);
  });

  it('lets one send use another sender of the same tenant', async () => {
    const res = await send(client, { sender: 'billing' });
    await runOnce();
    const sent = logOutbox.find((e) => e.messageId === res.json.id)!;
    expect(sent.from).toEqual({ email: `billing@${client.tenant.slug}.test`, name: 'Billing' });
    expect(sent.replyTo).toBe('help@example.org');
  });

  it('refuses senders on unverified domains', async () => {
    await db.domain.updateMany({ where: { tenantId: client.tenant.id }, data: { verifiedAt: null } });
    expect((await send(client, {})).json.error.code).toBe('domain_unverified');
  });

  it('keeps tenants apart', async () => {
    const res = await send(client, {});
    const other = await newTenant(`other${Date.now()}`);
    expect((await other.call('GET', `/v1/messages/${res.json.id}`)).status).toBe(404);
    expect((await other.call('POST', '/v1/send', { template: 'account.verify-email', to: { email: 'a@b.co' } })).status).toBe(404);
  });

  it('reports each email of a batch on its own', async () => {
    const res = await client.call('POST', '/v1/send/batch', {
      messages: [
        { template: 'account.verify-email', to: { email: 'a@b.co' }, variables: { verifyUrl: 'u' } },
        { template: 'nope', to: { email: 'a@b.co' } },
      ],
    });
    expect(res.status).toBe(207);
    expect(res.json.results[0].status).toBe('queued');
    expect(res.json.results[1].error.code).toBe('template_not_found');
  });

  it('requires a valid API key', async () => {
    const res = await app.request('/v1/templates', { headers: { authorization: 'Bearer pbx_nope' } });
    expect(res.status).toBe(401);
  });
});

describe('delivery', () => {
  it('fails over to the fallback connection', async () => {
    await client.call('PUT', '/v1/connections/primary', { type: 'log', credentials: { fail: true }, fallback: 'backup' });
    const res = await send(client, {});
    await runOnce();
    const msg = await db.message.findUniqueOrThrow({ where: { id: res.json.id }, include: { connection: true } });
    expect(msg.status).toBe('sent');
    expect(msg.connection?.name).toBe('backup');
    expect(msg.lastError).toContain('primary');
  });

  it('requeues with backoff when every connection fails', async () => {
    await client.call('PUT', '/v1/connections/backup', { type: 'log', credentials: { fail: true } });
    await client.call('PUT', '/v1/connections/primary', { type: 'log', credentials: { fail: true }, fallback: 'backup' });
    const res = await send(client, {});
    await runOnce();
    const msg = await db.message.findUniqueOrThrow({ where: { id: res.json.id } });
    expect(msg.status).toBe('queued');
    expect(msg.attempts).toBe(1);
    expect(msg.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 20_000);
  });

  it('skips a connection that reached its daily limit', async () => {
    await client.call('PUT', '/v1/connections/primary', { type: 'log', credentials: { quiet: true }, fallback: 'backup', dailyLimit: 1 });
    await send(client, {});
    await runOnce();
    const second = await send(client, {});
    await runOnce();
    const msg = await db.message.findUniqueOrThrow({ where: { id: second.json.id }, include: { connection: true } });
    expect(msg.connection?.name).toBe('backup');
  });
});

describe('suppressions', () => {
  it('blocks bounced addresses but lets unsubscribed ones get transactional email', async () => {
    await client.call('POST', '/v1/suppressions', { email: 'ana@example.com', reason: 'unsubscribe' });
    expect((await send(client, {})).json.status).toBe('queued');
    await client.call('POST', '/v1/suppressions', { email: 'ana@example.com', reason: 'bounce' });
    expect((await send(client, {})).json.status).toBe('suppressed');
  });
});

describe('templates', () => {
  it('versions each save and rolls back by publishing an older version', async () => {
    const path = '/v1/templates/account.verify-email/locales/en';
    const v2 = await client.call('PUT', path, { subject: 'Draft', bodyMjml: mjml('draft') });
    expect(v2.json).toEqual({ locale: 'en', version: 2, published: false });
    expect((await client.call('POST', `${path}/versions/2/publish`)).status).toBe(200);
    expect((await client.call('POST', '/v1/templates/account.verify-email/preview', {})).json.subject).toBe('Draft');
    await client.call('POST', `${path}/versions/1/publish`);
    expect((await client.call('POST', '/v1/templates/account.verify-email/preview', {})).json.subject).toBe('Confirm, Ana');
  });

  it('rejects broken template syntax at save time', async () => {
    const res = await client.call('PUT', '/v1/templates/account.verify-email/locales/en', { subject: 'Hi {{#if}}', bodyMjml: mjml('x') });
    expect(res.status).toBe(422);
  });

  it('lists templates with their published locales', async () => {
    const res = await client.call('GET', '/v1/templates');
    expect(res.json[0]).toMatchObject({ key: 'account.verify-email', sender: 'noreply', publishedLocales: ['en', 'ro'] });
  });

  it('only changes the fields a PATCH sends', async () => {
    await client.call('PATCH', '/v1/templates/account.verify-email', { name: 'Renamed' });
    const t = await client.call('GET', '/v1/templates/account.verify-email');
    expect(t.json.name).toBe('Renamed');
    expect(t.json.variables).toHaveLength(2);
  });
});

describe('connections', () => {
  it('never returns credentials and stores them encrypted', async () => {
    await client.call('PUT', '/v1/connections/sg', { type: 'sendgrid', credentials: { apiKey: 'SG.secret-value' } });
    const list = await client.call('GET', '/v1/connections');
    expect(JSON.stringify(list.json)).not.toContain('secret-value');
    const row = await db.connection.findFirstOrThrow({ where: { tenantId: client.tenant.id, name: 'sg' } });
    expect(row.encryptedCredentials).not.toContain('secret-value');
  });

  it('validates credentials per connection type', async () => {
    const res = await client.call('PUT', '/v1/connections/bad', { type: 'smtp', credentials: { host: 'x' } });
    expect(res.status).toBe(400);
  });
});
