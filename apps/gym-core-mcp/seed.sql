-- Seed data for gym-core (canonical) D1.
-- Safe to re-run: uses INSERT OR IGNORE / UPSERT patterns.
PRAGMA foreign_keys = ON;

-- Gym
INSERT OR IGNORE INTO gyms (gym_id, name, timezone, created_at_iso, updated_at_iso)
VALUES ('gym_erie_community_center', 'Erie Community Center', 'America/Denver', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z');

-- Metadata (hours, location)
INSERT INTO gym_metadata (gym_id, key, value_json, created_at_iso, updated_at_iso)
VALUES
  ('gym_erie_community_center', 'location', '{"lat":40.03781,"lon":-105.05228,"address":"450 Powers Street","city":"Erie","state":"CO","postalCode":"80516"}', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z')
ON CONFLICT(gym_id, key) DO UPDATE SET value_json=excluded.value_json, updated_at_iso=excluded.updated_at_iso;

INSERT INTO gym_metadata (gym_id, key, value_json, created_at_iso, updated_at_iso)
VALUES
  ('gym_erie_community_center', 'hours', '{"mon_thu":"05:00-21:00","fri":"05:00-19:00","sat":"07:00-19:00","sun":"08:00-17:00"}', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z')
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
  ('inst_alex', 'acc_inst_alex', '["personal_training","strength_training","beginner_onboarding"]', 'cms/instructor/inst_alex', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('inst_maya', 'acc_inst_maya', '["group_fitness","youth_programs","mobility"]', 'cms/instructor/inst_maya', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('inst_sam',  'acc_inst_sam',  '["aquatics","swim_lessons","water_aerobics"]', 'cms/instructor/inst_sam', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('inst_jordan','acc_inst_jordan','["adult_sports","pickleball","court_sports"]', 'cms/instructor/inst_jordan', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('inst_nina', 'acc_inst_nina', '["climbing","belay_certification","risk_management"]', 'cms/instructor/inst_nina', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('inst_eli',  'acc_inst_eli',  '["senior_fitness","injury_prevention","private_training"]', 'cms/instructor/inst_eli', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z');

-- Class definitions (group + private)
INSERT INTO class_definitions (
  class_def_id, title, type, skill_level, duration_minutes, default_capacity, is_outdoor, description_source_id, created_at_iso, updated_at_iso
) VALUES
  ('cdef_group_fitness_dropin', 'Drop-in Group Fitness', 'group', 'beginner', 60, 30, 0, 'cms/class_definition/cdef_group_fitness_dropin', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('cdef_private_training_60', 'Personal Training (60 min)', 'private', 'beginner', 60, 1, 0, 'cms/class_definition/cdef_private_training_60', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('cdef_open_gym', 'Open Gym (Drop-in)', 'group', 'beginner', 120, 40, 0, 'cms/class_definition/cdef_open_gym', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('cdef_open_gym_caregiver_child', 'Open Gym Drop-in: Caregiver and Child (Ages 2–5)', 'group', 'beginner', 60, 30, 0, 'cms/class_definition/cdef_open_gym_caregiver_child', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('cdef_pickleball_indoor', 'Indoor Pickleball (Drop-in)', 'group', 'beginner', 120, 24, 0, 'cms/class_definition/cdef_pickleball_indoor', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('cdef_pool_lap_swim', 'Lap Swim', 'group', 'beginner', 120, 18, 0, 'cms/class_definition/cdef_pool_lap_swim', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('cdef_pool_open_swim', 'Open Swim', 'group', 'beginner', 90, 60, 0, 'cms/class_definition/cdef_pool_open_swim', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('cdef_water_aerobics', 'Water Aerobics', 'group', 'beginner', 60, 25, 0, 'cms/class_definition/cdef_water_aerobics', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('cdef_climbing_supervised_open_climb', 'Climbing Wall: Supervised Open Climb', 'group', 'beginner', 120, 20, 0, 'cms/class_definition/cdef_climbing_supervised_open_climb', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('cdef_climbing_belay_skills_training', 'Climbing Wall: Belay Skills Training Course', 'group', 'intermediate', 90, 12, 0, 'cms/class_definition/cdef_climbing_belay_skills_training', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('cdef_climbing_teen_bouldering_orientation', 'Climbing Wall: Teen Bouldering Orientation (Ages 12–17)', 'group', 'beginner', 60, 12, 0, 'cms/class_definition/cdef_climbing_teen_bouldering_orientation', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z')
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
  ('access_day_pass', 'Daily Drop-in (All Day)', 'access', 2500, 'cms/product/access_day_pass', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('access_10_visit_punch', '10-Visit Pass', 'access', 20000, 'cms/product/access_10_visit_punch', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('access_5_visit_punch', '5-Visit Pass', 'access', 11000, 'cms/product/access_5_visit_punch', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('memb_monthly_individual', 'Monthly Membership (Individual)', 'membership', 8900, 'cms/product/memb_monthly_individual', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('memb_monthly_family', 'Monthly Membership (Family)', 'membership', 15900, 'cms/product/memb_monthly_family', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('memb_locker_addon', 'Locker Add-On (Monthly)', 'membership', 1200, 'cms/product/memb_locker_addon', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('rental_harness_day', 'Climbing Harness Loan (Day)', 'rental', 0, 'cms/product/rental_harness_day', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('rental_belay_device', 'Belay Device Loan (Day)', 'rental', 0, 'cms/product/rental_belay_device', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('class_group_fitness_dropin', 'Program: Drop-in Group Fitness', 'coaching', 0, 'cms/product/class_group_fitness_dropin', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('class_belay_skills_training', 'Program: Belay Skills Training Course', 'coaching', 0, 'cms/product/class_belay_skills_training', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('coaching_personal_training_60', 'Personal Training: 60 minutes', 'coaching', 9000, 'cms/product/coaching_personal_training_60', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('lesson_pickleball_private_60', 'Private Pickleball Lesson (60 min)', 'coaching', 6000, 'cms/product/lesson_pickleball_private_60', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z'),
  ('party_climbing_wall', 'Climbing Wall Party (Facility Booking)', 'camp', 0, 'cms/product/party_climbing_wall', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z')
ON CONFLICT(sku) DO UPDATE SET
  name=excluded.name,
  category=excluded.category,
  price_cents=excluded.price_cents,
  description_source_id=excluded.description_source_id,
  updated_at_iso=excluded.updated_at_iso;

-- Link class definitions to purchase SKUs
INSERT OR IGNORE INTO class_def_products (class_def_id, sku) VALUES
  ('cdef_group_fitness_dropin', 'class_group_fitness_dropin'),
  ('cdef_private_training_60', 'coaching_personal_training_60'),
  ('cdef_climbing_belay_skills_training', 'class_belay_skills_training'),
  ('cdef_climbing_supervised_open_climb', 'access_day_pass'),
  ('cdef_open_gym', 'access_day_pass'),
  ('cdef_pickleball_indoor', 'access_day_pass');

