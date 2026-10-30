import { postJson } from './http.js';
import type { OutgoingEmail, Provider } from './types.js';

export type SendgridCredentials = { apiKey: string; region?: 'global' | 'eu' };

export function sendgridProvider(creds: SendgridCredentials): Provider {
  const host = creds.region === 'eu' ? 'https://api.eu.sendgrid.com' : 'https://api.sendgrid.com';
  return {
    async send(email: OutgoingEmail) {
      const content = [{ type: 'text/html', value: email.html }];
      if (email.text) content.unshift({ type: 'text/plain', value: email.text });
      const res = await postJson(
        `${host}/v3/mail/send`,
        { authorization: `Bearer ${creds.apiKey}` },
        {
          personalizations: [{ to: [{ email: email.to.email, name: email.to.name ?? undefined }] }],
          from: { email: email.from.email, name: email.from.name },
          reply_to: email.replyTo ? { email: email.replyTo } : undefined,
          subject: email.subject,
          content,
          categories: email.tags.slice(0, 10),
          custom_args: { postbox_id: email.messageId },
        },
      );
      // SendGrid answers 202 with an empty body and the id in a header.
      return { providerMessageId: res.headers.get('x-message-id') ?? undefined };
    },
  };
}
