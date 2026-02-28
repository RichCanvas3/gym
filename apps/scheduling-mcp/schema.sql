-- D1 schema for gym scheduling MCP

PRAGMA foreign_keys = ON;

-- Scheduler-only DB: references identities by canonical account address string.
-- Canonical account rows live in gym-core (NOT here).

CREATE TABLE IF NOT EXISTS instructors (
  instructor_id TEXT PRIMARY KEY,
  instructor_account_address TEXT NOT NULL UNIQUE,
  display_name TEXT,
  skills_json TEXT,
  created_at_iso TEXT NOT NULL,
  updated_at_iso TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS classes (
  class_id TEXT PRIMARY KEY,
  class_def_id TEXT, -- optional pointer to gym-core class definition
  title TEXT NOT NULL,
  type TEXT NOT NULL, -- 'group' | 'private'
  skill_level TEXT, -- optional; kept for parity with ops demo data
  start_time_iso TEXT NOT NULL,
  start_unix INTEGER NOT NULL, -- seconds UTC
  end_unix INTEGER NOT NULL,   -- seconds UTC
  duration_minutes INTEGER NOT NULL,
  capacity INTEGER NOT NULL,
  instructor_account_address TEXT,
  is_outdoor INTEGER NOT NULL DEFAULT 0,
  created_at_iso TEXT NOT NULL,
  updated_at_iso TEXT NOT NULL,
  FOREIGN KEY (instructor_account_address) REFERENCES instructors(instructor_account_address)
);

CREATE INDEX IF NOT EXISTS idx_classes_start_unix ON classes(start_unix);
CREATE INDEX IF NOT EXISTS idx_classes_instructor_time ON classes(instructor_account_address, start_unix, end_unix);
CREATE INDEX IF NOT EXISTS idx_classes_class_def_id ON classes(class_def_id);

CREATE TABLE IF NOT EXISTS reservations (
  reservation_id TEXT PRIMARY KEY,
  class_id TEXT NOT NULL,
  customer_account_address TEXT NOT NULL,
  status TEXT NOT NULL, -- 'active' | 'cancelled'
  reserved_at_iso TEXT NOT NULL,
  cancelled_at_iso TEXT,
  FOREIGN KEY (class_id) REFERENCES classes(class_id)
);

CREATE INDEX IF NOT EXISTS idx_reservations_class_status ON reservations(class_id, status);
CREATE INDEX IF NOT EXISTS idx_reservations_customer_account ON reservations(customer_account_address);

