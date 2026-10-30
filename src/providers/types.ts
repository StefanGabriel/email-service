export type OutgoingEmail = {
  from: { email: string; name: string };
  to: { email: string; name?: string | null };
  replyTo?: string | null;
  subject: string;
  html: string;
  text?: string | null;
  tags: string[];
  messageId: string;
};

export type SendResult = { providerMessageId?: string };

export interface Provider {
  send(email: OutgoingEmail): Promise<SendResult>;
}

// Thrown when retrying the same provider later will not help (bad credentials, rejected address).
export class PermanentProviderError extends Error {}
