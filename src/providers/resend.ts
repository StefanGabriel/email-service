import { formatAddress, postJson } from './http.js';
import type { OutgoingEmail, Provider } from './types.js';

export type ResendCredentials = { apiKey: string };

export function resendProvider(creds: ResendCredentials): Provider {
  return {
    async send(email: OutgoingEmail) {
      const res = await postJson(
        'https://api.resend.com/emails',
        { authorization: `Bearer ${creds.apiKey}`, 'idempotency-key': email.messageId },
        {
          from: formatAddress(email.from),
          to: [formatAddress(email.to)],
          reply_to: email.replyTo ?? undefined,
          subject: email.subject,
          html: email.html,
          text: email.text ?? undefined,
          tags: [{ name: 'postbox_id', value: email.messageId }],
        },
      );
      const body = (await res.json()) as { id?: string };
      return { providerMessageId: body.id };
    },
  };
}
