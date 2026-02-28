-- Migrate scheduling DB from v2 (accounts/customers) to v3 (scheduler-only).
-- Notes:
-- - This script RENAMES v2 tables to *_v2 as backups.
-- - Then creates v3 tables and migrates data by resolving canonical addresses.
-- - D1 CLI does not support explicit BEGIN/COMMIT statements here.

PRAGMA foreign_keys = OFF;

-- Backup old tables (will fail if already renamed; run once)
ALTER TABLE reservations RENAME TO reservations_v2;
ALTER TABLE classes RENAME TO classes_v2;
ALTER TABLE instructors RENAME TO instructors_v2;
ALTER TABLE customers RENAME TO customers_v2;
ALTER TABLE accounts RENAME TO accounts_v2;

PRAGMA foreign_keys = ON;

-- v3 tables
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
  class_def_id TEXT,
  title TEXT NOT NULL,
  type TEXT NOT NULL,
  skill_level TEXT,
  start_time_iso TEXT NOT NULL,
  start_unix INTEGER NOT NULL,
  end_unix INTEGER NOT NULL,
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
  status TEXT NOT NULL,
  reserved_at_iso TEXT NOT NULL,
  cancelled_at_iso TEXT,
  FOREIGN KEY (class_id) REFERENCES classes(class_id)
);

CREATE INDEX IF NOT EXISTS idx_reservations_class_status ON reservations(class_id, status);
CREATE INDEX IF NOT EXISTS idx_reservations_customer_account ON reservations(customer_account_address);

-- Migrate instructors (resolve account_id -> canonical_address)
INSERT INTO instructors (instructor_id, instructor_account_address, display_name, skills_json, created_at_iso, updated_at_iso)
SELECT
  i.instructor_id,
  a.canonical_address,
  a.display_name,
  i.skills_json,
  i.created_at_iso,
  i.updated_at_iso
FROM instructors_v2 i
JOIN accounts_v2 a ON a.account_id = i.account_id;

-- Migrate classes (resolve instructor_id -> account_id -> canonical_address)
INSERT INTO classes (
  class_id, class_def_id, title, type, skill_level, start_time_iso, start_unix, end_unix, duration_minutes, capacity,
  instructor_account_address, is_outdoor, created_at_iso, updated_at_iso
)
SELECT
  c.class_id,
  NULL AS class_def_id,
  c.title,
  c.type,
  c.skill_level,
  c.start_time_iso,
  c.start_unix,
  c.end_unix,
  c.duration_minutes,
  c.capacity,
  a.canonical_address AS instructor_account_address,
  c.is_outdoor,
  c.created_at_iso,
  c.updated_at_iso
FROM classes_v2 c
LEFT JOIN instructors_v2 i ON i.instructor_id = c.instructor_id
LEFT JOIN accounts_v2 a ON a.account_id = i.account_id;

-- Migrate reservations (resolve customer_account_id -> canonical_address)
INSERT INTO reservations (reservation_id, class_id, customer_account_address, status, reserved_at_iso, cancelled_at_iso)
SELECT
  r.reservation_id,
  r.class_id,
  a.canonical_address,
  r.status,
  r.reserved_at_iso,
  r.cancelled_at_iso
FROM reservations_v2 r
JOIN accounts_v2 a ON a.account_id = r.customer_account_id;

