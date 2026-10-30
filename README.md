# Postbox

A small multi-tenant email service. Apps send an email with one call (template, recipient, variables); Postbox renders a localized, versioned template, picks the sender and delivery connection, queues the email and retries or fails over until it is delivered.

Phase 1 of the plan: [Reusable email service plan](https://claude.ai/artifact/R21Bv5Bh9jgxfPSMxwwcq7). The admin UI, provider webhooks, newsletters and SaaS sign-up come in later phases; everything here is already scoped per tenant.

## Concepts

| Object | What it holds |
| --- | --- |
| Tenant | A customer. Has API keys; every other object belongs to one tenant. |
| Connection | How mail leaves: `smtp`, `resend`, `brevo`, `sendgrid`, or `log` (prints, for development). Credentials are encrypted with `POSTBOX_SECRET_KEY` and never returned. Optional daily limit and a fallback connection. |
| Domain | A sending domain. Must be verified with a DNS TXT record before it can send. Has a default connection. |
| Sender | From name, from address on a domain, reply-to, optional connection override. |
| Template | Key, category (transactional or marketing), default sender, default locale, declared variables. |
| Template version | Subject, MJML body and text body for one locale. Each save is a new version; the latest published version is live. |

## Run locally

```bash
cp .env.example .env           # fill POSTBOX_SECRET_KEY with: openssl rand -base64 32
npm install
npx prisma migrate deploy
npm run seed                   # tenant "resume-builder", a log connection, a verify-email template in EN and RO; prints an API key
npm run dev
```

Tests run against a real Postgres database (`postbox_test` by default, override with `TEST_DATABASE_URL`):

```bash
npm test
```

## Send an email

```http
POST /v1/send
Authorization: Bearer pbx_...
Idempotency-Key: order-8812-receipt

{
  "template": "account.verify-email",
  "to": { "email": "ana@example.com", "name": "Ana" },
  "locale": "ro-RO",
  "variables": { "name": "Ana", "verifyUrl": "https://cv.example.com/verify?t=..." },
  "sender": "billing",
  "tags": ["resume-builder"]
}

202 { "id": "cm...", "status": "queued" }
```

- `locale` falls back from `ro-RO` to `ro` to the template's default locale.
- `sender` is optional and must be another sender key of the same tenant; addresses cannot be typed freely.
- A missing required variable returns `422 missing_variables`. An unverified domain returns `422 domain_unverified`.
- The same `Idempotency-Key` returns the first message instead of sending again.
- Bounced or complained addresses are suppressed for all email; unsubscribed addresses only for `marketing` templates.

## API

All routes need `Authorization: Bearer <api key>`.

| Method and path | Purpose |
| --- | --- |
| `POST /v1/send` | Queue one email |
| `POST /v1/send/batch` | Up to 100 emails; each result reported separately (207) |
| `GET /v1/messages/:id` | Status: `queued`, `sending`, `sent`, `failed`, `suppressed` |
| `GET /v1/templates` | Templates with variables and published locales |
| `POST /v1/templates` | Create a template |
| `PATCH /v1/templates/:key` | Change name, category, sender, default locale or variables |
| `GET /v1/templates/:key` | Template with its version history |
| `PUT /v1/templates/:key/locales/:locale` | Save a new version (`publish: true` to make it live) |
| `GET /v1/templates/:key/locales/:locale/versions/:n` | One version's content |
| `POST /v1/templates/:key/locales/:locale/versions/:n/publish` | Publish a version (also how rollback works) |
| `POST /v1/templates/:key/preview` | Render unsaved `content` or the live version with sample variables |
| `GET`, `PUT /v1/connections/:name` | List, create or replace a connection |
| `GET`, `POST /v1/domains`, `PATCH /v1/domains/:name` | Domains and their verification record |
| `POST /v1/domains/:name/verify` | Check the `_postbox.<domain>` TXT record |
| `GET`, `PUT /v1/senders/:key` | Senders |
| `GET`, `POST /v1/suppressions`, `DELETE /v1/suppressions/:email` | Suppression list |

Connection credentials by type:

| Type | Credentials |
| --- | --- |
| `smtp` | `{ host, port, secure, user?, pass? }` (`secure: true` for 465, `false` for STARTTLS on 587) |
| `resend` | `{ apiKey }` |
| `brevo` | `{ apiKey }` |
| `sendgrid` | `{ apiKey, region?: "global" \| "eu" }` (REST `v3/mail/send`) |
| `log` | `{ fail?, quiet? }` |

## Delivery

A worker in the same process claims queued messages with `FOR UPDATE SKIP LOCKED`, so several instances can share the queue. It tries the sender's connection (or the domain default), then each fallback in turn, skipping connections over their daily limit. If all fail, the message is retried with backoff (30s, 1m, 2m, ...) up to `MAX_ATTEMPTS`; errors that will not improve on retry, such as a rejected API key, fail it at once.

## Tenants

```bash
npm run tenant -- acme "Acme Ltd"   # creates the tenant if needed and prints a new API key
```

## Homelab deployment

`docker-compose.yml` runs Postgres, Postbox and (with `--profile tunnel`) `cloudflared`. Put `POSTBOX_SECRET_KEY` and `CLOUDFLARE_TUNNEL_TOKEN` in a `.env` next to it, then:

```bash
docker compose --profile tunnel up -d --build
```

Migrations run on container start.
