-- Seed data for gym-scheduling (scheduler-only) D1.
-- Safe to re-run (mostly): instructor inserts are OR IGNORE; class ids are stable.
PRAGMA foreign_keys = ON;

-- Helper timestamps are hardcoded for determinism.
-- These are UTC ISO strings; the app can display in America/Denver.

-- Instructors keyed by canonical account address (matches gym-core accounts.canonical_address)
INSERT OR IGNORE INTO instructors (instructor_id, instructor_account_address, display_name, skills_json, created_at_iso, updated_at_iso) VALUES
  ('sched_inst_alex', 'acct_inst_alex', 'Alex Rivera', '["belay","lead","anchors","movement"]', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('sched_inst_maya', 'acct_inst_maya', 'Maya Chen', '["belay","movement","youth_programs"]', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('sched_inst_sam',  'acct_inst_sam',  'Sam Patel',  '["strength_training","bouldering","injury_prevention"]', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('sched_inst_jordan','acct_inst_jordan','Jordan Lee', '["lead","sport_climbing","mental_skills"]', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('sched_inst_nina', 'acct_inst_nina', 'Nina Alvarez', '["outdoor_guiding","anchors","leave_no_trace"]', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('sched_inst_eli',  'acct_inst_eli',  'Eli Thompson', '["private_coaching","technique","belay"]', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z');

-- Classes for the week around 2026-03-01 (UTC).
-- NOTE: start_unix/end_unix are seconds since epoch (UTC).
INSERT OR REPLACE INTO classes (
  class_id, class_def_id, title, type, skill_level, start_time_iso, start_unix, end_unix, duration_minutes, capacity,
  instructor_account_address, is_outdoor, created_at_iso, updated_at_iso
) VALUES
  -- Sun 2026-03-01
  ('class_20260301_1700_intro_belay', 'cdef_intro_belay', 'Intro to Belay (Top Rope)', 'group', 'beginner',
   '2026-03-01T17:00:00.000Z', 1772384400, 1772389800, 90, 8, 'acct_inst_maya', 0, '2026-02-20T00:00:00Z', '2026-02-20T00:00:00Z'),
  ('class_20260301_1900_movement_lab', 'cdef_movement_lab', 'Movement Lab (Footwork + Balance)', 'group', 'beginner',
   '2026-03-01T19:00:00.000Z', 1772391600, 1772396100, 75, 12, 'acct_inst_sam', 0, '2026-02-20T00:00:00Z', '2026-02-20T00:00:00Z'),
  ('class_20260301_2000_outdoor_access', 'cdef_outdoor_access', 'Outdoor Wall Access (Weather-Dependent)', 'group', 'beginner',
   '2026-03-01T20:00:00.000Z', 1772395200, 1772402400, 120, 20, 'acct_inst_nina', 1, '2026-02-20T00:00:00Z', '2026-02-20T00:00:00Z'),

  -- Mon 2026-03-02
  ('class_20260302_0100_private_coaching', 'cdef_private_coaching_60', 'Private Coaching (60 min)', 'private', 'beginner',
   '2026-03-02T01:00:00.000Z', 1772413200, 1772416800, 60, 1, 'acct_inst_eli', 0, '2026-02-20T00:00:00Z', '2026-02-20T00:00:00Z'),
  ('class_20260302_1700_fall_practice', 'cdef_fall_practice', 'Falling Practice Workshop', 'group', 'intermediate',
   '2026-03-02T17:00:00.000Z', 1772470800, 1772476200, 90, 8, 'acct_inst_jordan', 0, '2026-02-20T00:00:00Z', '2026-02-20T00:00:00Z'),

  -- Tue 2026-03-03
  ('class_20260303_1730_anchor_clinic', 'cdef_anchor_clinic', 'Anchor Clinic (Gym Anchors)', 'group', 'intermediate',
   '2026-03-03T17:30:00.000Z', 1772559000, 1772566200, 120, 10, 'acct_inst_alex', 0, '2026-02-20T00:00:00Z', '2026-02-20T00:00:00Z'),

  -- Wed 2026-03-04
  ('class_20260304_1800_lead_101', 'cdef_lead_101', 'Lead Climbing 101', 'group', 'intermediate',
   '2026-03-04T18:00:00.000Z', 1772656800, 1772665800, 150, 6, 'acct_inst_jordan', 0, '2026-02-20T00:00:00Z', '2026-02-20T00:00:00Z'),
  ('class_20260304_2000_private_lead', 'cdef_private_lead_60', 'Private Lead Tune-Up (60 min)', 'private', 'advanced',
   '2026-03-04T20:00:00.000Z', 1772664000, 1772667600, 60, 1, 'acct_inst_alex', 0, '2026-02-20T00:00:00Z', '2026-02-20T00:00:00Z'),

  -- Thu 2026-03-05 (outdoor session)
  ('class_20260305_2000_outdoor_access', 'cdef_outdoor_access', 'Outdoor Wall Access (Weather-Dependent)', 'group', 'beginner',
   '2026-03-05T20:00:00.000Z', 1772750400, 1772757600, 120, 20, 'acct_inst_nina', 1, '2026-02-20T00:00:00Z', '2026-02-20T00:00:00Z');

-- Example reservation (so calendar can show "reserved" demo if you use acct_cust_casey in waiver)
INSERT OR IGNORE INTO reservations (reservation_id, class_id, customer_account_address, status, reserved_at_iso)
VALUES ('res_demo_casey_1', 'class_20260301_1700_intro_belay', 'acct_cust_casey', 'active', '2026-02-28T12:00:00Z');

