import nodemailer from 'nodemailer';
import { PermanentProviderError, type OutgoingEmail, type Provider } from './types.js';

export type SmtpCredentials = {
  host: string;
  port: number;
  // true = TLS from the first byte (465); false = STARTTLS upgrade (587)
  secure: boolean;
  user?: string;
  pass?: string;
};

export function smtpProvider(creds: SmtpCredentials): Provider {
  const transport = nodemailer.createTransport({
    host: creds.host,
    port: creds.port,
    secure: creds.secure,
    auth: creds.user ? { user: creds.user, pass: creds.pass } : undefined,
    connectionTimeout: 15_000,
  });
  return {
    async send(email: OutgoingEmail) {
      try {
        const info = await transport.sendMail({
          from: { address: email.from.email, name: email.from.name },
          to: email.to.name ? { address: email.to.email, name: email.to.name } : email.to.email,
          replyTo: email.replyTo ?? undefined,
          subject: email.subject,
          html: email.html,
          text: email.text ?? undefined,
          headers: { 'X-Postbox-Id': email.messageId },
        });
        return { providerMessageId: info.messageId };
      } catch (err) {
        const code = (err as { responseCode?: number }).responseCode;
        // 5xx SMTP replies are permanent (auth failed, mailbox rejected); 4xx and network errors are not.
        if (code && code >= 500) throw new PermanentProviderError((err as Error).message);
        throw err;
      } finally {
        transport.close();
      }
    },
  };
}
