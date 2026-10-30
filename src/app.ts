import { Hono } from 'hono';
import { requireApiKey, type Env } from './auth.js';
import { ApiError } from './errors.js';
import { sendRoutes } from './routes/send.js';
import { setupRoutes } from './routes/setup.js';
import { templateRoutes } from './routes/templates.js';

export const app = new Hono<Env>();

app.onError((err, c) => {
  if (err instanceof ApiError) {
    return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status);
  }
  console.error('[postbox]', err);
  return c.json({ error: { code: 'internal', message: 'Internal error' } }, 500);
});

app.get('/health', (c) => c.json({ ok: true }));

app.use('/v1/*', requireApiKey);
app.route('/v1', sendRoutes);
app.route('/v1', templateRoutes);
app.route('/v1', setupRoutes);
