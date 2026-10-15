ALTER TABLE email_outbox ADD COLUMN sent_at TEXT;
ALTER TABLE email_outbox ADD COLUMN error TEXT;
ALTER TABLE email_outbox ADD COLUMN attempts INTEGER DEFAULT 0;
