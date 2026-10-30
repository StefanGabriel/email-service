import { postJson } from './http.js';
import type { OutgoingEmail, Provider } from './types.js';

export type BrevoCredentials = { apiKey: string };

export function brevoProvider(creds: BrevoCredentials): Provider {
  return {
    async send(email: OutgoingEmail) {
      const res = await postJson(
        'https://api.brevo.com/v3/smtp/email',
        { 'api-key': creds.apiKey, accept: 'application/json' },
        {
          sender: { email: email.from.email, name: email.from.name },
          to: [{ email: email.to.email, name: email.to.name ?? undefined }],
          replyTo: email.replyTo ? { email: email.replyTo } : undefined,
          subject: email.subject,
          htmlContent: email.html,
          textContent: email.text ?? undefined,
          tags: email.tags.length ? email.tags : undefined,
          headers: { 'X-Postbox-Id': email.messageId },
        },
      );
      const body = (await res.json()) as { messageId?: string };
      return { providerMessageId: body.messageId };
    },
  };
}
