// Usage: npm run tenant -- <slug> "<Name>"
// Creates a tenant (or reuses it) and prints a new API key. The key is shown once.
import { generateApiKey } from '../src/crypto.js';
import { db } from '../src/db.js';

const [slug, name = slug] = process.argv.slice(2);
if (!slug) {
  console.error('Usage: npm run tenant -- <slug> "<Name>"');
  process.exit(1);
}

const tenant = await db.tenant.upsert({ where: { slug }, create: { slug, name }, update: {} });
const { key, prefix, hash } = generateApiKey();
await db.apiKey.create({ data: { tenantId: tenant.id, name: 'cli', prefix, hash } });
console.log(`Tenant ${tenant.slug} (${tenant.id})\nAPI key: ${key}`);
await db.$disconnect();
