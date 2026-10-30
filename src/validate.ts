import type { Context } from 'hono';
import type { z } from 'zod';
import { ApiError } from './errors.js';

export async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, 'invalid_json', 'Request body must be JSON');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new ApiError(400, 'invalid_request', 'Request body is invalid', parsed.error.issues);
  }
  return parsed.data;
}
