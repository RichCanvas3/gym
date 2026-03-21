-- Seed data for gym-content (rich content) D1.
-- Stores markdown docs linked to core entities by id/sku.
PRAGMA foreign_keys = ON;

-- Gym overview
INSERT INTO content_docs (doc_id, entity_type, entity_id, locale, title, slug, body_markdown, tags_json, created_at_iso, updated_at_iso)
VALUES (
  'doc_gym_overview_en',
  'gym',
  'gym_erie_community_center',
  'en',
  'Erie Community Center',
  'erie-community-center',
  '# Welcome\n\nThe **Erie Community Center (ECC)** is a recreation facility with individual and group fitness, a full-court gymnasium, an indoor pool (lazy river + hot tub), racquetball, meeting rooms, and a **climbing wall**.\n\n## Amenities\n- Group fitness (drop-in + registration-based)\n- Gymnasium drop-ins (open gym, court sports)\n- Aquatics (lap swim, open swim, lessons, water aerobics)\n- Indoor pickleball (seasonal schedule)\n- Climbing wall (bouldering + roped pinnacle)\n\n## Location + hours\n- 450 Powers Street, Erie, CO 80516\n- Typical hours: Mon–Thu 5am–9pm; Fri 5am–7pm; Sat 7am–7pm; Sun 8am–5pm\n\nAsk for schedules and we’ll show times and help you reserve when reservations are available.\n',
  '["gym","overview","erie"]',
  '2026-02-01T00:00:00Z',
  '2026-02-01T00:00:00Z'
)
ON CONFLICT(doc_id) DO UPDATE SET
  entity_type=excluded.entity_type,
  entity_id=excluded.entity_id,
  locale=excluded.locale,
  title=excluded.title,
  slug=excluded.slug,
  body_markdown=excluded.body_markdown,
  tags_json=excluded.tags_json,
  updated_at_iso=excluded.updated_at_iso;

-- Policies (waiver + cancellations)
INSERT INTO content_docs (doc_id, entity_type, entity_id, locale, title, slug, body_markdown, tags_json, created_at_iso, updated_at_iso)
VALUES (
  'doc_policy_waiver_en',
  'policy',
  'waiver',
  'en',
  'Waiver + Minors',
  'waiver-minors',
  '# Waiver\n\nA waiver may be required for certain activities.\n\n## Minors\nIf the participant is under 18, a **parent/guardian** must complete and sign the waiver.\n\n## Climbing wall\nThe ECC climbing wall requires a climbing waiver before accessing the wall.\n\n## Notes\nOptional fields may be collected for safety and lost-and-found.\n',
  '["policy","waiver","minors"]',
  '2026-02-01T00:00:00Z',
  '2026-02-01T00:00:00Z'
)
ON CONFLICT(entity_type, entity_id, locale) DO UPDATE SET body_markdown=excluded.body_markdown, updated_at_iso=excluded.updated_at_iso;

INSERT INTO content_docs (doc_id, entity_type, entity_id, locale, title, slug, body_markdown, tags_json, created_at_iso, updated_at_iso)
VALUES (
  'doc_policy_cancellation_en',
  'policy',
  'cancellation',
  'en',
  'Class Cancellation + Late Policy',
  'class-cancellation',
  '# Cancellation policy\n\n- Cancel **24 hours** before start for a full refund/credit.\n- Cancelling inside 24h may forfeit the booking unless we can fill the spot.\n- No-shows are not refundable.\n\n## Late arrival\nArrive 10 minutes early. If you''re late, we may not be able to complete instruction safely.\n',
  '["policy","cancellation"]',
  '2026-02-01T00:00:00Z',
  '2026-02-01T00:00:00Z'
)
ON CONFLICT(entity_type, entity_id, locale) DO UPDATE SET body_markdown=excluded.body_markdown, updated_at_iso=excluded.updated_at_iso;

-- Instructor bios (entity_id uses core instructors.instructor_id)
INSERT INTO content_docs (doc_id, entity_type, entity_id, locale, title, slug, body_markdown, tags_json, created_at_iso, updated_at_iso) VALUES
(
  'doc_inst_alex_en','instructor','inst_alex','en','Alex Rivera','alex-rivera',
  '# Alex Rivera\n\nAlex specializes in **lead systems**, anchors, and building calm, repeatable belay habits.\n\n## Coaching style\n- Technique-first, then efficiency\n- Practical safety habits\n- Clear progressions and homework drills\n\n## Good fit for\n- Lead 101 / lead refreshers\n- Anchor clinic\n- Anyone who wants to feel calmer on the sharp end\n',
  '["instructor","lead","anchors"]','2026-02-01T00:00:00Z','2026-02-01T00:00:00Z'
),
(
  'doc_inst_maya_en','instructor','inst_maya','en','Maya Chen','maya-chen',
  '# Maya Chen\n\nMaya is known for beginner on-ramps and friendly, confidence-building instruction.\n\n## Focus areas\n- Belay foundations\n- Movement basics\n- Youth programming\n\n## You''ll like Maya''s sessions if\nYou want clear steps, lots of reps, and a supportive vibe.\n',
  '["instructor","belay","beginner"]','2026-02-01T00:00:00Z','2026-02-01T00:00:00Z'
),
(
  'doc_inst_sam_en','instructor','inst_sam','en','Sam Patel','sam-patel',
  '# Sam Patel\n\nSam blends movement coaching with strength programming.\n\n## Specialty\n- Bouldering movement\n- Injury-prevention habits\n- Training plans for busy people\n\n## Typical takeaways\nYou leave with 2–3 drills you can repeat for a month.\n',
  '["instructor","training","bouldering"]','2026-02-01T00:00:00Z','2026-02-01T00:00:00Z'
),
(
  'doc_inst_jordan_en','instructor','inst_jordan','en','Jordan Lee','jordan-lee',
  '# Jordan Lee\n\nJordan focuses on lead confidence, route reading, and practical tactics.\n\n## Best for\n- Lead 101\n- Falling practice\n- “I can climb it, but I panic mid-route”\n',
  '["instructor","lead","mental"]','2026-02-01T00:00:00Z','2026-02-01T00:00:00Z'
),
(
  'doc_inst_nina_en','instructor','inst_nina','en','Nina Alvarez','nina-alvarez',
  '# Nina Alvarez\n\nNina leads outdoor skills and weather-aware risk management.\n\n## Outdoor ops\nOutdoor sessions may change quickly; Nina teaches conservative decision-making.\n\n## Best for\n- Outdoor wall access sessions\n- Anchors + systems basics\n',
  '["instructor","outdoor","risk_management"]','2026-02-01T00:00:00Z','2026-02-01T00:00:00Z'
),
(
  'doc_inst_eli_en','instructor','inst_eli','en','Eli Thompson','eli-thompson',
  '# Eli Thompson\n\nEli runs private coaching with a structured assessment and clear next steps.\n\n## Private coaching format\n1) warmup + movement screen\n2) skill focus block\n3) short “send” attempts\n4) take-home plan\n',
  '["instructor","private_coaching"]','2026-02-01T00:00:00Z','2026-02-01T00:00:00Z'
)
ON CONFLICT(entity_type, entity_id, locale) DO UPDATE SET body_markdown=excluded.body_markdown, updated_at_iso=excluded.updated_at_iso;

-- Class definition descriptions (entity_id uses core class_definitions.class_def_id)
INSERT INTO content_docs (doc_id, entity_type, entity_id, locale, title, slug, body_markdown, tags_json, created_at_iso, updated_at_iso) VALUES
(
  'doc_cdef_group_fitness_dropin_en','class_definition','cdef_group_fitness_dropin','en','Drop-in Group Fitness','dropin-group-fitness',
  '# Drop-in Group Fitness\n\nA general-purpose class definition used for group fitness sessions (strength, HIIT, mobility, etc.).\n\nSchedules vary by season.\n',
  '["class","fitness","group"]','2026-02-01T00:00:00Z','2026-02-01T00:00:00Z'
),
(
  'doc_cdef_private_training_60_en','class_definition','cdef_private_training_60','en','Personal Training (60 min)','personal-training-60',
  '# Personal Training (60 min)\n\nA 1:1 training session tailored to your goals.\n\n## Common goals\n- strength plan\n- weight loss support\n- mobility and injury prevention\n',
  '["class","training","private"]','2026-02-01T00:00:00Z','2026-02-01T00:00:00Z'
),
(
  'doc_cdef_open_gym_en','class_definition','cdef_open_gym','en','Open Gym (Drop-in)','open-gym',
  '# Open Gym (Drop-in)\n\nShared gymnasium time for drop-in activities.\n\nSchedules vary by season.\n',
  '["class","open_gym"]','2026-02-01T00:00:00Z','2026-02-01T00:00:00Z'
),
(
  'doc_cdef_open_gym_caregiver_child_en','class_definition','cdef_open_gym_caregiver_child','en','Open Gym Drop-in: Caregiver and Child (Ages 2–5)','open-gym-caregiver-child',
  '# Open Gym: Caregiver and Child\n\nAges 2–5 with caregiver. Low-key play and exploration.\n\nNo registration needed.\n',
  '["class","open_gym","youth"]','2026-02-01T00:00:00Z','2026-02-01T00:00:00Z'
),
(
  'doc_cdef_pickleball_indoor_en','class_definition','cdef_pickleball_indoor','en','Indoor Pickleball (Drop-in)','indoor-pickleball',
  '# Indoor Pickleball (Drop-in)\n\nIndoor pickleball is available seasonally.\n\nBring your own paddle/balls; nets are provided.\n',
  '["class","pickleball","sports"]','2026-02-01T00:00:00Z','2026-02-01T00:00:00Z'
),
(
  'doc_cdef_pool_lap_swim_en','class_definition','cdef_pool_lap_swim','en','Lap Swim','lap-swim',
  '# Lap Swim\n\nLap lanes are available during designated times.\n\nLane availability can vary with lessons and events.\n',
  '["class","aquatics","lap_swim"]','2026-02-01T00:00:00Z','2026-02-01T00:00:00Z'
),
(
  'doc_cdef_pool_open_swim_en','class_definition','cdef_pool_open_swim','en','Open Swim','open-swim',
  '# Open Swim\n\nFamily-friendly open swim with features varying by schedule (slide, rope swing, etc.).\n',
  '["class","aquatics","open_swim"]','2026-02-01T00:00:00Z','2026-02-01T00:00:00Z'
),
(
  'doc_cdef_climbing_supervised_open_climb_en','class_definition','cdef_climbing_supervised_open_climb','en','Climbing Wall: Supervised Open Climb','climbing-supervised-open-climb',
  '# Supervised Open Climb\n\nStaff-supervised climbing time at the ECC climbing wall.\n\nThe ECC climbing wall includes a 15-foot bouldering wall and a 32-foot pinnacle.\n',
  '["class","climbing"]','2026-02-01T00:00:00Z','2026-02-01T00:00:00Z'
),
(
  'doc_cdef_climbing_belay_skills_training_en','class_definition','cdef_climbing_belay_skills_training','en','Climbing Wall: Belay Skills Training Course','belay-skills-training',
  '# Belay Skills Training Course\n\nEarn belay certification for unsupervised roped climbing access.\n\nBelay certifications must be renewed periodically.\n',
  '["class","climbing","belay"]','2026-02-01T00:00:00Z','2026-02-01T00:00:00Z'
),
(
  'doc_cdef_climbing_teen_bouldering_orientation_en','class_definition','cdef_climbing_teen_bouldering_orientation','en','Climbing Wall: Teen Bouldering Orientation (Ages 12–17)','teen-bouldering-orientation',
  '# Teen Bouldering Orientation\n\nOrientation for ages 12–17 to access bouldering without adult supervision.\n',
  '["class","climbing","youth"]','2026-02-01T00:00:00Z','2026-02-01T00:00:00Z'
)
ON CONFLICT(entity_type, entity_id, locale) DO UPDATE SET body_markdown=excluded.body_markdown, updated_at_iso=excluded.updated_at_iso;

-- Product descriptions (entity_id uses core products.sku)
INSERT INTO content_docs (doc_id, entity_type, entity_id, locale, title, slug, body_markdown, tags_json, created_at_iso, updated_at_iso) VALUES
('doc_prod_access_day_pass_en','product','access_day_pass','en','Daily Drop-in (All Day)','daily-dropin',
'# Daily Drop-in\n\nAll-day access during staffed hours.\n\nSpecific amenities and features vary by schedule.\n','["product","access"]','2026-02-01T00:00:00Z','2026-02-01T00:00:00Z'),
('doc_prod_access_5_visit_en','product','access_5_visit_punch','en','5-Visit Punch Pass','5-visit-pass',
'# 5-Visit Punch Pass\n\nFlexible visits for people who climb a couple times a month.\n\n## Notes\nPunch passes are not transferable.\n','["product","access"]','2026-02-01T00:00:00Z','2026-02-01T00:00:00Z'),
('doc_prod_memb_individual_en','product','memb_monthly_individual','en','Monthly Membership (Individual)','membership-individual',
'# Monthly Membership\n\nUnlimited access + member perks.\n\n## Perks\n- discounts on classes\n- priority booking windows (when available)\n- guest day-pass discount\n','["product","membership"]','2026-02-01T00:00:00Z','2026-02-01T00:00:00Z'),
('doc_prod_rental_harness_en','product','rental_harness_day','en','Climbing Harness Loan (Day)','harness-loan',
'# Climbing Harness Loan\n\nHarness loan availability is handled at the front desk.\n','["product","rental","climbing"]','2026-02-01T00:00:00Z','2026-02-01T00:00:00Z'),
('doc_prod_belay_device_en','product','rental_belay_device','en','Belay Device Loan (Day)','belay-device-loan',
'# Belay Device Loan\n\nBelay device loan availability is handled at the front desk.\n','["product","rental","climbing"]','2026-02-01T00:00:00Z','2026-02-01T00:00:00Z'),
('doc_prod_personal_training_60_en','product','coaching_personal_training_60','en','Personal Training: 60 minutes','personal-training',
'# Personal Training (60)\n\nBook a 1:1 training session.\n','["product","coaching","private"]','2026-02-01T00:00:00Z','2026-02-01T00:00:00Z'),
('doc_prod_party_climbing_wall_en','product','party_climbing_wall','en','Climbing Wall Party (Facility Booking)','climbing-party',
'# Climbing Wall Parties\n\nClimbing wall parties are facility bookings.\n','["product","party","climbing"]','2026-02-01T00:00:00Z','2026-02-01T00:00:00Z')
ON CONFLICT(entity_type, entity_id, locale) DO UPDATE SET body_markdown=excluded.body_markdown, updated_at_iso=excluded.updated_at_iso;

