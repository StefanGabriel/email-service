import { randomUUID } from 'node:crypto';
import type { OutgoingEmail, Provider } from './types.js';

// Development and test connection: prints instead of sending. `fail` simulates an outage.
export type LogCredentials = { fail?: boolean; quiet?: boolean };

export const logOutbox: OutgoingEmail[] = [];

export function logProvider(creds: LogCredentials): Provider {
  return {
    async send(email: OutgoingEmail) {
      if (creds.fail) throw new Error('log connection configured to fail');
      logOutbox.push(email);
      if (!creds.quiet) console.log(`[postbox:log] ${email.from.email} -> ${email.to.email}: ${email.subject}`);
      return { providerMessageId: `log_${randomUUID()}` };
    },
  };
}
