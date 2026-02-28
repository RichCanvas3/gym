-- Seed data for gym-core (canonical) D1.
-- Safe to re-run: uses INSERT OR IGNORE / UPSERT patterns.
PRAGMA foreign_keys = ON;

-- Gym
INSERT OR IGNORE INTO gyms (gym_id, name, timezone, created_at_iso, updated_at_iso)
VALUES ('gym_front_range_boulder', 'Front Range Climbing (Boulder)', 'America/Denver', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z');

-- Metadata (hours, location)
INSERT INTO gym_metadata (gym_id, key, value_json, created_at_iso, updated_at_iso)
VALUES
  ('gym_front_range_boulder', 'location', '{"lat":40.015,"lon":-105.2705,"city":"Boulder","state":"CO"}', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z')
ON CONFLICT(gym_id, key) DO UPDATE SET value_json=excluded.value_json, updated_at_iso=excluded.updated_at_iso;

INSERT INTO gym_metadata (gym_id, key, value_json, created_at_iso, updated_at_iso)
VALUES
  ('gym_front_range_boulder', 'hours', '{"mon_fri":"06:00-22:00","sat":"08:00-20:00","sun":"08:00-20:00"}', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z')
ON CONFLICT(gym_id, key) DO UPDATE SET value_json=excluded.value_json, updated_at_iso=excluded.updated_at_iso;

-- Instructor accounts (canonical_address is NOT email)
INSERT OR IGNORE INTO accounts (account_id, canonical_address, email, display_name, phone_e164, created_at_iso, updated_at_iso) VALUES
  ('acc_inst_alex', 'acct_inst_alex', 'alex.coach@example.com', 'Alex Rivera', '+13035550101', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('acc_inst_maya', 'acct_inst_maya', 'maya.coach@example.com', 'Maya Chen', '+13035550102', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('acc_inst_sam',  'acct_inst_sam',  'sam.coach@example.com',  'Sam Patel',  '+13035550103', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('acc_inst_jordan','acct_inst_jordan','jordan.coach@example.com','Jordan Lee', '+13035550104', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('acc_inst_nina', 'acct_inst_nina', 'nina.coach@example.com', 'Nina Alvarez', '+13035550105', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('acc_inst_eli',  'acct_inst_eli',  'eli.coach@example.com',  'Eli Thompson', '+13035550106', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z');

-- Example customer accounts
INSERT OR IGNORE INTO accounts (account_id, canonical_address, email, display_name, phone_e164, created_at_iso, updated_at_iso) VALUES
  ('acc_cust_casey', 'acct_cust_casey', 'casey@example.com', 'Casey Morgan', '+13035550901', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('acc_cust_riley', 'acct_cust_riley', 'riley@example.com', 'Riley Kim', '+13035550902', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z');

INSERT OR IGNORE INTO customers (customer_id, account_id, created_at_iso, updated_at_iso) VALUES
  ('cust_casey', 'acc_cust_casey', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('cust_riley', 'acc_cust_riley', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z');

-- Instructors (link to account_id)
INSERT OR IGNORE INTO instructors (instructor_id, account_id, skills_json, bio_source_id, created_at_iso, updated_at_iso) VALUES
  ('inst_alex', 'acc_inst_alex', '["belay","lead","anchors","movement","risk_management"]', 'cms/instructor/inst_alex', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('inst_maya', 'acc_inst_maya', '["belay","youth_programs","movement","technique"]', 'cms/instructor/inst_maya', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('inst_sam',  'acc_inst_sam',  '["strength_training","bouldering","movement","injury_prevention"]', 'cms/instructor/inst_sam', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('inst_jordan','acc_inst_jordan','["lead","sport_climbing","route_reading","mental_skills"]', 'cms/instructor/inst_jordan', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('inst_nina', 'acc_inst_nina', '["outdoor_guiding","trad_basics","anchors","leave_no_trace"]', 'cms/instructor/inst_nina', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('inst_eli',  'acc_inst_eli',  '["private_coaching","technique","beginner_progressions","belay"]', 'cms/instructor/inst_eli', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z');

-- Class definitions (group + private)
INSERT INTO class_definitions (
  class_def_id, title, type, skill_level, duration_minutes, default_capacity, is_outdoor, description_source_id, created_at_iso, updated_at_iso
) VALUES
  ('cdef_intro_belay', 'Intro to Belay (Top Rope)', 'group', 'beginner', 90, 8, 0, 'cms/class_definition/cdef_intro_belay', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('cdef_anchor_clinic', 'Anchor Clinic (Gym Anchors)', 'group', 'intermediate', 120, 10, 0, 'cms/class_definition/cdef_anchor_clinic', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('cdef_lead_101', 'Lead Climbing 101', 'group', 'intermediate', 150, 6, 0, 'cms/class_definition/cdef_lead_101', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('cdef_fall_practice', 'Falling Practice Workshop', 'group', 'intermediate', 90, 8, 0, 'cms/class_definition/cdef_fall_practice', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('cdef_movement_lab', 'Movement Lab (Footwork + Balance)', 'group', 'beginner', 75, 12, 0, 'cms/class_definition/cdef_movement_lab', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('cdef_outdoor_access', 'Outdoor Wall Access (Weather-Dependent)', 'group', 'beginner', 120, 20, 1, 'cms/class_definition/cdef_outdoor_access', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('cdef_private_coaching_60', 'Private Coaching (60 min)', 'private', 'beginner', 60, 1, 0, 'cms/class_definition/cdef_private_coaching_60', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('cdef_private_lead_60', 'Private Lead Tune-Up (60 min)', 'private', 'advanced', 60, 1, 0, 'cms/class_definition/cdef_private_lead_60', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('cdef_youth_team_intro', 'Youth Team Tryout Prep', 'group', 'intermediate', 90, 10, 0, 'cms/class_definition/cdef_youth_team_intro', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z')
ON CONFLICT(class_def_id) DO UPDATE SET
  title=excluded.title,
  type=excluded.type,
  skill_level=excluded.skill_level,
  duration_minutes=excluded.duration_minutes,
  default_capacity=excluded.default_capacity,
  is_outdoor=excluded.is_outdoor,
  description_source_id=excluded.description_source_id,
  updated_at_iso=excluded.updated_at_iso;

-- Products (membership/access/rentals/retail/camp/coaching)
INSERT INTO products (sku, name, category, price_cents, description_source_id, created_at_iso, updated_at_iso) VALUES
  ('access_day_pass', 'Day Pass (All Day)', 'access', 2500, 'cms/product/access_day_pass', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('access_10_visit_punch', '10-Visit Punch Pass', 'access', 20000, 'cms/product/access_10_visit_punch', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('access_5_visit_punch', '5-Visit Punch Pass', 'access', 11000, 'cms/product/access_5_visit_punch', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('memb_monthly_individual', 'Monthly Membership (Individual)', 'membership', 8900, 'cms/product/memb_monthly_individual', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('memb_monthly_family', 'Monthly Membership (Family)', 'membership', 15900, 'cms/product/memb_monthly_family', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('memb_locker_addon', 'Locker Add-On (Monthly)', 'membership', 1200, 'cms/product/memb_locker_addon', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('rental_shoes_day', 'Shoe Rental (Day)', 'rental', 600, 'cms/product/rental_shoes_day', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('rental_harness_day', 'Harness Rental (Day)', 'rental', 700, 'cms/product/rental_harness_day', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('rental_belay_device', 'Belay Device Rental (Day)', 'rental', 500, 'cms/product/rental_belay_device', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('retail_chalk_bag', 'Chalk Bag (Basic)', 'retail', 2500, 'cms/product/retail_chalk_bag', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('retail_liquid_chalk', 'Liquid Chalk (50ml)', 'retail', 1200, 'cms/product/retail_liquid_chalk', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('retail_tape_roll', 'Climbing Tape (1 roll)', 'retail', 800, 'cms/product/retail_tape_roll', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('class_intro_belay', 'Class: Intro to Belay', 'coaching', 5900, 'cms/product/class_intro_belay', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('class_lead_101', 'Class: Lead Climbing 101', 'coaching', 8900, 'cms/product/class_lead_101', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('class_movement_lab', 'Class: Movement Lab', 'coaching', 3900, 'cms/product/class_movement_lab', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('class_anchor_clinic', 'Class: Anchor Clinic', 'coaching', 7500, 'cms/product/class_anchor_clinic', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('coaching_private_60', 'Private Coaching: 60 minutes', 'coaching', 12000, 'cms/product/coaching_private_60', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('coaching_private_lead_60', 'Private Coaching: Lead Tune-Up (60)', 'coaching', 15000, 'cms/product/coaching_private_lead_60', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('camp_spring_break_3day', 'Camp: Spring Break (3 days)', 'camp', 29900, 'cms/product/camp_spring_break_3day', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z')
ON CONFLICT(sku) DO UPDATE SET
  name=excluded.name,
  category=excluded.category,
  price_cents=excluded.price_cents,
  description_source_id=excluded.description_source_id,
  updated_at_iso=excluded.updated_at_iso;

-- Link class definitions to purchase SKUs
INSERT OR IGNORE INTO class_def_products (class_def_id, sku) VALUES
  ('cdef_intro_belay', 'class_intro_belay'),
  ('cdef_lead_101', 'class_lead_101'),
  ('cdef_movement_lab', 'class_movement_lab'),
  ('cdef_anchor_clinic', 'class_anchor_clinic'),
  ('cdef_private_coaching_60', 'coaching_private_60'),
  ('cdef_private_lead_60', 'coaching_private_lead_60'),
  ('cdef_outdoor_access', 'access_day_pass');

