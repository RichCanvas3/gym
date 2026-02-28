-- D1 schema for gym scheduling MCP

PRAGMA foreign_keys = ON;

-- Canonical accounts (instructors + customers) for identity integrity.
-- Canonical address is typically a normalized email (lowercased, trimmed).
CREATE TABLE IF NOT EXISTS accounts (
  account_id TEXT PRIMARY KEY,
  canonical_address TEXT NOT NULL UNIQUE,
  email TEXT,
  display_name TEXT,
  phone_e164 TEXT,
  created_at_iso TEXT NOT NULL,
  updated_at_iso TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS instructors (
  instructor_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL UNIQUE,
  skills_json TEXT,
  created_at_iso TEXT NOT NULL,
  updated_at_iso TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(account_id)
);

CREATE TABLE IF NOT EXISTS customers (
  customer_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL UNIQUE,
  created_at_iso TEXT NOT NULL,
  updated_at_iso TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(account_id)
);

CREATE TABLE IF NOT EXISTS classes (
  class_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  type TEXT NOT NULL, -- 'group' | 'private'
  skill_level TEXT, -- optional; kept for parity with ops demo data
  start_time_iso TEXT NOT NULL,
  start_unix INTEGER NOT NULL, -- seconds UTC
  end_unix INTEGER NOT NULL,   -- seconds UTC
  duration_minutes INTEGER NOT NULL,
  capacity INTEGER NOT NULL,
  instructor_id TEXT,
  is_outdoor INTEGER NOT NULL DEFAULT 0,
  created_at_iso TEXT NOT NULL,
  updated_at_iso TEXT NOT NULL,
  FOREIGN KEY (instructor_id) REFERENCES instructors(instructor_id)
);

CREATE INDEX IF NOT EXISTS idx_classes_start_unix ON classes(start_unix);
CREATE INDEX IF NOT EXISTS idx_classes_instructor_time ON classes(instructor_id, start_unix, end_unix);

CREATE TABLE IF NOT EXISTS reservations (
  reservation_id TEXT PRIMARY KEY,
  class_id TEXT NOT NULL,
  customer_account_id TEXT NOT NULL,
  status TEXT NOT NULL, -- 'active' | 'cancelled'
  reserved_at_iso TEXT NOT NULL,
  cancelled_at_iso TEXT,
  FOREIGN KEY (class_id) REFERENCES classes(class_id),
  FOREIGN KEY (customer_account_id) REFERENCES accounts(account_id)
);

CREATE INDEX IF NOT EXISTS idx_reservations_class_status ON reservations(class_id, status);
CREATE INDEX IF NOT EXISTS idx_reservations_customer_account ON reservations(customer_account_id);

