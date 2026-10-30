// Local development data: a "resume-builder" tenant that logs emails instead of sending them.
import { encryptJson, generateApiKey } from '../src/crypto.js';
import { db } from '../src/db.js';

const tenant = await db.tenant.upsert({
  where: { slug: 'resume-builder' },
  create: { slug: 'resume-builder', name: 'Resume builder' },
  update: {},
});
const connection = await db.connection.upsert({
  where: { tenantId_name: { tenantId: tenant.id, name: 'dev-log' } },
  create: { tenantId: tenant.id, name: 'dev-log', type: 'log', encryptedCredentials: encryptJson({}) },
  update: {},
});
const domain = await db.domain.upsert({
  where: { tenantId_name: { tenantId: tenant.id, name: 'example.com' } },
  create: { tenantId: tenant.id, name: 'example.com', verifiedAt: new Date(), defaultConnectionId: connection.id },
  update: {},
});
const sender = await db.sender.upsert({
  where: { tenantId_key: { tenantId: tenant.id, key: 'noreply' } },
  create: { tenantId: tenant.id, key: 'noreply', domainId: domain.id, fromName: 'Resume Builder', fromLocal: 'noreply' },
  update: {},
});

const verifyEmail = await db.template.upsert({
  where: { tenantId_key: { tenantId: tenant.id, key: 'account.verify-email' } },
  create: {
    tenantId: tenant.id,
    key: 'account.verify-email',
    name: 'Verify email address',
    senderId: sender.id,
    variables: [
      { name: 'name', required: false, sample: 'Ana' },
      { name: 'verifyUrl', required: true, sample: 'https://example.com/verify?t=123' },
    ],
  },
  update: {},
});

const body = (greeting: string, text: string, button: string) => `<mjml>
  <mj-body background-color="#f4f4f5">
    <mj-section background-color="#ffffff" padding="32px">
      <mj-column>
        <mj-text font-size="18px" font-weight="600">${greeting}</mj-text>
        <mj-text>${text}</mj-text>
        <mj-button href="{{verifyUrl}}" background-color="#2563eb">${button}</mj-button>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`;

const versions = [
  { locale: 'en', subject: 'Confirm your email', mjml: body('Hi {{name}},', 'Please confirm your email address to finish signing up.', 'Confirm email'), text: 'Hi {{name}},\n\nConfirm your email: {{verifyUrl}}' },
  { locale: 'ro', subject: 'Confirmă adresa de email', mjml: body('Salut {{name}},', 'Te rugăm să confirmi adresa de email pentru a finaliza înregistrarea.', 'Confirmă emailul'), text: 'Salut {{name}},\n\nConfirmă emailul: {{verifyUrl}}' },
];
for (const v of versions) {
  const exists = await db.templateVersion.findFirst({ where: { templateId: verifyEmail.id, locale: v.locale } });
  if (exists) continue;
  await db.templateVersion.create({
    data: { templateId: verifyEmail.id, locale: v.locale, version: 1, subject: v.subject, bodyMjml: v.mjml, bodyText: v.text, publishedAt: new Date() },
  });
}

const { key, prefix, hash } = generateApiKey();
await db.apiKey.create({ data: { tenantId: tenant.id, name: 'seed', prefix, hash } });
console.log(`Seeded tenant resume-builder.\nAPI key: ${key}`);
await db.$disconnect();
