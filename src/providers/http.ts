import { PermanentProviderError } from './types.js';

export async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<Response> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (res.ok) return res;
  const detail = (await res.text()).slice(0, 500);
  const message = `${new URL(url).host} answered ${res.status}: ${detail}`;
  // 429 and 5xx are worth retrying; other 4xx mean the request itself is wrong.
  if (res.status !== 429 && res.status < 500) throw new PermanentProviderError(message);
  throw new Error(message);
}

export const formatAddress = (a: { email: string; name?: string | null }) =>
  a.name ? `"${a.name.replace(/"/g, '')}" <${a.email}>` : a.email;
