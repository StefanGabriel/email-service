import { z } from 'zod';
import type { ConnectionType } from '../generated/prisma/client.js';
import { brevoProvider } from './brevo.js';
import { logProvider } from './log.js';
import { resendProvider } from './resend.js';
import { sendgridProvider } from './sendgrid.js';
import { smtpProvider } from './smtp.js';
import type { Provider } from './types.js';

export const credentialSchemas = {
  smtp: z.object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    secure: z.boolean(),
    user: z.string().optional(),
    pass: z.string().optional(),
  }),
  resend: z.object({ apiKey: z.string().min(1) }),
  brevo: z.object({ apiKey: z.string().min(1) }),
  sendgrid: z.object({ apiKey: z.string().min(1), region: z.enum(['global', 'eu']).optional() }),
  log: z.object({ fail: z.boolean().optional(), quiet: z.boolean().optional() }),
} satisfies Record<ConnectionType, z.ZodType>;

export function createProvider(type: ConnectionType, credentials: unknown): Provider {
  switch (type) {
    case 'smtp':
      return smtpProvider(credentialSchemas.smtp.parse(credentials));
    case 'resend':
      return resendProvider(credentialSchemas.resend.parse(credentials));
    case 'brevo':
      return brevoProvider(credentialSchemas.brevo.parse(credentials));
    case 'sendgrid':
      return sendgridProvider(credentialSchemas.sendgrid.parse(credentials));
    case 'log':
      return logProvider(credentialSchemas.log.parse(credentials));
  }
}
