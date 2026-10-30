import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from './config.js';

// AES-256-GCM, stored as base64(iv | tag | ciphertext).
export function encryptJson(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', config.secretKey, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
}

export function decryptJson<T>(payload: string): T {
  const raw = Buffer.from(payload, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', config.secretKey, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  const body = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
  return JSON.parse(body.toString('utf8')) as T;
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function generateApiKey(): { key: string; prefix: string; hash: string } {
  const key = `pbx_${randomBytes(24).toString('base64url')}`;
  return { key, prefix: key.slice(0, 10), hash: hashApiKey(key) };
}
