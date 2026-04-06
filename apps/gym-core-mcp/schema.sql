-- D1 schema: gym-core canonical data
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS gym_metadata (
  gym_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  created_at_iso TEXT NOT NULL,
  updated_at_iso TEXT NOT NULL,
  PRIMARY KEY (gym_id, key)
);

-- Canonical accounts; canonical_address is the app-defined stable address.
CREATE TABLE IF NOT EXISTS accounts (
  account_id TEXT PRIMARY KEY,
  canonical_address TEXT NOT NULL UNIQUE,
  email TEXT,
  display_name TEXT,
  phone_e164 TEXT,
  created_at_iso TEXT NOT NULL,
  updated_at_iso TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_accounts_canonical_address ON accounts(canonical_address);

CREATE TABLE IF NOT EXISTS instructors (
  instructor_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL UNIQUE,
  skills_json TEXT,
  bio_source_id TEXT, -- markdown sourceId (optional)
  created_at_iso TEXT NOT NULL,
  updated_at_iso TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(account_id)
);

CREATE TABLE IF NOT EXISTS class_definitions (
  class_def_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  type TEXT NOT NULL, -- 'group' | 'private'
  skill_level TEXT,
  duration_minutes INTEGER NOT NULL,
  default_capacity INTEGER NOT NULL,
  is_outdoor INTEGER NOT NULL DEFAULT 0,
  description_source_id TEXT, -- markdown sourceId (optional)
  created_at_iso TEXT NOT NULL,
  updated_at_iso TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_class_definitions_type ON class_definitions(type);

CREATE TABLE IF NOT EXISTS products (
  sku TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL, -- e.g. 'access' | 'membership' | 'rental' | 'retail' | 'camp' | 'coaching'
  price_cents INTEGER NOT NULL,
  description_source_id TEXT, -- rich content sourceId (optional)
  created_at_iso TEXT NOT NULL,
  updated_at_iso TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_products_category ON products(category);

CREATE TABLE IF NOT EXISTS class_def_products (
  class_def_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  PRIMARY KEY (class_def_id, sku),
  FOREIGN KEY (class_def_id) REFERENCES class_definitions(class_def_id),
  FOREIGN KEY (sku) REFERENCES products(sku)
);

-- Persistent user memory (chat threads + messages)
CREATE TABLE IF NOT EXISTS chat_threads (
  thread_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  title TEXT,
  created_at_iso TEXT NOT NULL,
  updated_at_iso TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(account_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_threads_account ON chat_threads(account_id, updated_at_iso);

CREATE TABLE IF NOT EXISTS chat_messages (
  message_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  role TEXT NOT NULL, -- 'user' | 'assistant' | 'system'
  content TEXT NOT NULL,
  created_at_iso TEXT NOT NULL,
  FOREIGN KEY (thread_id) REFERENCES chat_threads(thread_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages(thread_id, created_at_iso);

-- Persistent KB index (embeddings + text)
CREATE TABLE IF NOT EXISTS kb_chunks (
  chunk_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  text TEXT NOT NULL,
  embedding_json TEXT NOT NULL,
  created_at_iso TEXT NOT NULL,
  updated_at_iso TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_kb_chunks_source ON kb_chunks(source_id);

-- External identities + profiles (3P integrations; keyed to accounts)
CREATE TABLE IF NOT EXISTS account_external_identities (
  account_id TEXT NOT NULL,
  provider TEXT NOT NULL, -- e.g. 'telegram' | 'strava' | 'google'
  external_user_id TEXT NOT NULL,
  created_at_iso TEXT NOT NULL,
  updated_at_iso TEXT NOT NULL,
  PRIMARY KEY (account_id, provider),
  UNIQUE (provider, external_user_id),
  FOREIGN KEY (account_id) REFERENCES accounts(account_id)
);

CREATE INDEX IF NOT EXISTS idx_external_identities_provider_user ON account_external_identities(provider, external_user_id);

CREATE TABLE IF NOT EXISTS account_external_profiles (
  account_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  profile_json TEXT NOT NULL,
  created_at_iso TEXT NOT NULL,
  updated_at_iso TEXT NOT NULL,
  PRIMARY KEY (account_id, provider),
  FOREIGN KEY (account_id) REFERENCES accounts(account_id)
);
