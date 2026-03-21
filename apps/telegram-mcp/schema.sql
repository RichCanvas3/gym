-- D1 schema: gym-telegram (bot updates + searchable message store)
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS telegram_chats (
  chat_id TEXT PRIMARY KEY,
  type TEXT,
  title TEXT,
  username TEXT,
  created_at_iso TEXT NOT NULL,
  updated_at_iso TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_telegram_chats_updated ON telegram_chats(updated_at_iso);

CREATE TABLE IF NOT EXISTS telegram_messages (
  id TEXT PRIMARY KEY, -- synthetic key: chat_id:message_id(:thread_id)
  chat_id TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  message_thread_id INTEGER,
  from_user_id INTEGER,
  date_unix INTEGER,
  text TEXT,
  raw_json TEXT NOT NULL,
  created_at_iso TEXT NOT NULL,
  FOREIGN KEY (chat_id) REFERENCES telegram_chats(chat_id)
);

CREATE INDEX IF NOT EXISTS idx_telegram_messages_chat ON telegram_messages(chat_id, date_unix);
CREATE INDEX IF NOT EXISTS idx_telegram_messages_text ON telegram_messages(text);

CREATE TABLE IF NOT EXISTS telegram_updates (
  update_id INTEGER PRIMARY KEY,
  received_at_iso TEXT NOT NULL,
  raw_json TEXT NOT NULL
);

-- MCP resource subscriptions: session_id + resource_uri (client subscribes to chat messages)
CREATE TABLE IF NOT EXISTS telegram_resource_subscriptions (
  session_id TEXT NOT NULL,
  resource_uri TEXT NOT NULL,
  created_at_iso TEXT NOT NULL,
  PRIMARY KEY (session_id, resource_uri)
);

CREATE INDEX IF NOT EXISTS idx_telegram_resource_subscriptions_uri ON telegram_resource_subscriptions(resource_uri);

-- Pending notifications: flushed on next MCP request for that session
CREATE TABLE IF NOT EXISTS telegram_pending_notifications (
  session_id TEXT NOT NULL,
  resource_uri TEXT NOT NULL,
  created_at_iso TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_telegram_pending_notifications_session ON telegram_pending_notifications(session_id);

-- Opaque tokens for public image URLs (/telegram/media/:token → proxy Telegram file by file_id)
CREATE TABLE IF NOT EXISTS telegram_media_tokens (
  token TEXT PRIMARY KEY,
  file_id TEXT NOT NULL,
  created_at_iso TEXT NOT NULL,
  expires_at_iso TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_telegram_media_expires ON telegram_media_tokens(expires_at_iso);

