PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS a2a_handles (
  handle TEXT PRIMARY KEY,
  account_address TEXT NOT NULL,
  telegram_user_id TEXT,
  created_at_iso TEXT NOT NULL,
  updated_at_iso TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_a2a_handles_account ON a2a_handles(account_address);

CREATE TABLE IF NOT EXISTS a2a_messages (
  message_id TEXT PRIMARY KEY,
  handle TEXT NOT NULL,
  from_agent_id TEXT,
  body_json TEXT NOT NULL,
  created_at_iso TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received',
  FOREIGN KEY (handle) REFERENCES a2a_handles(handle) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_a2a_messages_handle_created ON a2a_messages(handle, created_at_iso);

