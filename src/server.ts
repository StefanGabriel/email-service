import { serve } from '@hono/node-server';
import { app } from './app.js';
import { config } from './config.js';
import { db } from './db.js';
import { startWorker } from './worker.js';

const stopWorker = process.env.WORKER_DISABLED === '1' ? () => {} : startWorker();
const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`postbox listening on :${info.port}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    stopWorker();
    server.close(() => void db.$disconnect().then(() => process.exit(0)));
  });
}
