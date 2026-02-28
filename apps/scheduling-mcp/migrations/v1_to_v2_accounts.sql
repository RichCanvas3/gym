-- Migration: v1 (email/name in reservations, name in instructors) -> v2 (accounts + canonical addresses)
--
-- Use ONLY if your existing tables are from the older schema.
-- It rebuilds instructors/classes/reservations while preserving IDs and data.

PRAGMA foreign_keys = OFF;
-- D1 does not allow SQL BEGIN/COMMIT transactions in migrations executed via Wrangler.
-- This migration is written to be "safe-ish" by keeping v1 tables as backups.

-- New canonical accounts
CREATE TABLE IF NOT EXISTS accounts (
  account_id TEXT PRIMARY KEY,
  canonical_address TEXT NOT NULL UNIQUE,
  email TEXT,
  display_name TEXT,
  phone_e164 TEXT,
  created_at_iso TEXT NOT NULL,
  updated_at_iso TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
  customer_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL UNIQUE,
  created_at_iso TEXT NOT NULL,
  updated_at_iso TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(account_id)
);

-- Rename v1 tables out of the way.
-- Note: these statements will fail if run twice; run once per DB.
ALTER TABLE reservations RENAME TO reservations_v1;
ALTER TABLE classes RENAME TO classes_v1;
ALTER TABLE instructors RENAME TO instructors_v1;

-- v2 instructors
CREATE TABLE instructors (
  instructor_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL UNIQUE,
  skills_json TEXT,
  created_at_iso TEXT NOT NULL,
  updated_at_iso TEXT NOT NULL,
  FOREIGN KEY (account_id) REFERENCES accounts(account_id)
);

-- Create instructor accounts from v1 instructors.
INSERT OR IGNORE INTO accounts (account_id, canonical_address, email, display_name, phone_e164, created_at_iso, updated_at_iso)
SELECT
  'acc_' || instructor_id AS account_id,
  lower('instructor:' || instructor_id) AS canonical_address,
  NULL AS email,
  name AS display_name,
  NULL AS phone_e164,
  COALESCE(created_at_iso, datetime('now')) AS created_at_iso,
  COALESCE(updated_at_iso, datetime('now')) AS updated_at_iso
FROM instructors_v1;

INSERT INTO instructors (instructor_id, account_id, skills_json, created_at_iso, updated_at_iso)
SELECT
  instructor_id,
  'acc_' || instructor_id AS account_id,
  skills_json,
  COALESCE(created_at_iso, datetime('now')) AS created_at_iso,
  COALESCE(updated_at_iso, datetime('now')) AS updated_at_iso
FROM instructors_v1;

-- v2 classes (same columns as v1, but FK points to v2 instructors table name).
CREATE TABLE classes (
  class_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  type TEXT NOT NULL,
  skill_level TEXT,
  start_time_iso TEXT NOT NULL,
  start_unix INTEGER NOT NULL,
  end_unix INTEGER NOT NULL,
  duration_minutes INTEGER NOT NULL,
  capacity INTEGER NOT NULL,
  instructor_id TEXT,
  is_outdoor INTEGER NOT NULL DEFAULT 0,
  created_at_iso TEXT NOT NULL,
  updated_at_iso TEXT NOT NULL,
  FOREIGN KEY (instructor_id) REFERENCES instructors(instructor_id)
);

INSERT INTO classes (
  class_id, title, type, skill_level,
  start_time_iso, start_unix, end_unix, duration_minutes,
  capacity, instructor_id, is_outdoor,
  created_at_iso, updated_at_iso
)
SELECT
  class_id, title, type, skill_level,
  start_time_iso, start_unix, end_unix, duration_minutes,
  capacity, instructor_id, is_outdoor,
  COALESCE(created_at_iso, datetime('now')) AS created_at_iso,
  COALESCE(updated_at_iso, datetime('now')) AS updated_at_iso
FROM classes_v1;

CREATE INDEX IF NOT EXISTS idx_classes_start_unix ON classes(start_unix);
CREATE INDEX IF NOT EXISTS idx_classes_instructor_time ON classes(instructor_id, start_unix, end_unix);

-- v2 reservations
CREATE TABLE reservations (
  reservation_id TEXT PRIMARY KEY,
  class_id TEXT NOT NULL,
  customer_account_id TEXT NOT NULL,
  status TEXT NOT NULL,
  reserved_at_iso TEXT NOT NULL,
  cancelled_at_iso TEXT,
  FOREIGN KEY (class_id) REFERENCES classes(class_id),
  FOREIGN KEY (customer_account_id) REFERENCES accounts(account_id)
);

-- Create customer accounts from v1 reservations (canonical address = normalized email).
INSERT OR IGNORE INTO accounts (account_id, canonical_address, email, display_name, phone_e164, created_at_iso, updated_at_iso)
SELECT
  lower(trim(customer_email)) AS account_id,
  lower(trim(customer_email)) AS canonical_address,
  lower(trim(customer_email)) AS email,
  NULL AS display_name,
  NULL AS phone_e164,
  COALESCE(reserved_at_iso, datetime('now')) AS created_at_iso,
  COALESCE(reserved_at_iso, datetime('now')) AS updated_at_iso
FROM reservations_v1
WHERE customer_email IS NOT NULL AND trim(customer_email) != '';

-- Best-effort display name fill from any non-empty customer_name.
UPDATE accounts
SET display_name = (
  SELECT customer_name
  FROM reservations_v1 r
  WHERE lower(trim(r.customer_email)) = accounts.account_id
    AND r.customer_name IS NOT NULL
    AND trim(r.customer_name) != ''
  LIMIT 1
)
WHERE accounts.account_id LIKE '%@%';

INSERT OR IGNORE INTO customers (customer_id, account_id, created_at_iso, updated_at_iso)
SELECT
  'cust_' || account_id AS customer_id,
  account_id,
  created_at_iso,
  updated_at_iso
FROM accounts
WHERE account_id LIKE '%@%';

INSERT INTO reservations (reservation_id, class_id, customer_account_id, status, reserved_at_iso, cancelled_at_iso)
SELECT
  reservation_id,
  class_id,
  lower(trim(customer_email)) AS customer_account_id,
  status,
  COALESCE(reserved_at_iso, datetime('now')) AS reserved_at_iso,
  cancelled_at_iso
FROM reservations_v1;

CREATE INDEX IF NOT EXISTS idx_reservations_class_status ON reservations(class_id, status);
CREATE INDEX IF NOT EXISTS idx_reservations_customer_account ON reservations(customer_account_id);

PRAGMA foreign_keys = ON;

