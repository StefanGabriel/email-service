import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

export const config = {
  databaseUrl: required('DATABASE_URL'),
  // 32 random bytes, base64. Encrypts connection credentials at rest.
  secretKey: Buffer.from(required('POSTBOX_SECRET_KEY'), 'base64'),
  port: Number(process.env.PORT ?? 8080),
  workerIntervalMs: Number(process.env.WORKER_INTERVAL_MS ?? 2000),
  maxAttempts: Number(process.env.MAX_ATTEMPTS ?? 6),
};

if (config.secretKey.length !== 32) {
  throw new Error('POSTBOX_SECRET_KEY must be 32 bytes, base64 encoded (openssl rand -base64 32)');
}
