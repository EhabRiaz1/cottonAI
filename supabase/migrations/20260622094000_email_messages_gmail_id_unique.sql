-- Race-safe idempotency for the Gmail path: a message id is unique per mailbox.
CREATE UNIQUE INDEX IF NOT EXISTS uq_email_messages_mailbox_gmail_id
  ON public.email_messages (mailbox_email, gmail_message_id)
  WHERE gmail_message_id IS NOT NULL;
