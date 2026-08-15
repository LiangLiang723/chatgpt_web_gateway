ALTER TABLE conversations
  ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'clean'
  CHECK (sync_status IN ('clean', 'in_flight'));

ALTER TABLE conversations
  ADD COLUMN synced_message_count INTEGER NOT NULL DEFAULT 0
  CHECK (synced_message_count >= 0);

ALTER TABLE conversations
  ADD COLUMN sync_started_at INTEGER;
