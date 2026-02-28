-- Seed data for gym-content (rich content) D1.
-- Stores markdown docs linked to core entities by id/sku.
PRAGMA foreign_keys = ON;

-- Gym overview
INSERT INTO content_docs (doc_id, entity_type, entity_id, locale, title, slug, body_markdown, tags_json, created_at_iso, updated_at_iso)
VALUES (
  'doc_gym_overview_en',
  'gym',
  'gym_front_range_boulder',
  'en',
  'Front Range Climbing — Boulder',
  'front-range-climbing-boulder',
  '# Welcome\n\nFront Range Climbing is a modern bouldering + ropes facility with coaching, youth programs, and an **outdoor training wall** that operates **weather-dependently**.\n\n## What we do well\n- Beginner-friendly onboarding\n- Skill-building classes (belay, lead, movement)\n- Private coaching and performance training\n- Camps and youth progression tracks\n\n## What to bring\n- Comfortable athletic clothes\n- Socks if renting shoes\n- Water bottle\n\n## Outdoor wall operations\nOutdoor sessions may be adjusted or cancelled for:\n- lightning\n- high winds/gusts\n- heavy rain/snow\n- unsafe temperatures/ice\n\nWhen you ask about an outdoor class/access, we include a forecast snapshot.\n',
  '["gym","overview","boulder"]',
  '2026-02-01T00:00:00Z',
  '2026-02-01T00:00:00Z'
)
ON CONFLICT(entity_type, entity_id, locale) DO UPDATE SET body_markdown=excluded.body_markdown, updated_at_iso=excluded.updated_at_iso;

-- Policies (waiver + cancellations)
INSERT INTO content_docs (doc_id, entity_type, entity_id, locale, title, slug, body_markdown, tags_json, created_at_iso, updated_at_iso)
VALUES (
  'doc_policy_waiver_en',
  'policy',
  'waiver',
  'en',
  'Waiver + Minors',
  'waiver-minors',
  '# Waiver\n\nA waiver is required for anyone entering the climbing areas.\n\n## Minors\nIf the participant is under 18, a **parent/guardian** must complete and sign the waiver.\n\n## Photos and emergency contact\nOptional fields may be collected for safety and lost-and-found.\n',
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
  'doc_cdef_intro_belay_en','class_definition','cdef_intro_belay','en','Intro to Belay (Top Rope)','intro-to-belay',
  '# Intro to Belay (Top Rope)\n\nLearn the essential belay checks and safe habits to climb on top rope.\n\n## What you''ll learn\n- Harness + knot checks\n- Belay device setup\n- Communication commands\n- Lowering safely\n\n## Prereqs\nNone.\n\n## What to bring\nComfortable clothing and socks if renting shoes.\n',
  '["class","belay","beginner"]','2026-02-01T00:00:00Z','2026-02-01T00:00:00Z'
),
(
  'doc_cdef_anchor_clinic_en','class_definition','cdef_anchor_clinic','en','Anchor Clinic','anchor-clinic',
  '# Anchor Clinic\n\nA systems-focused clinic for gym anchors and efficient transitions.\n\n## Topics\n- clipping plans\n- redundancy + direction\n- cleaning at the anchor (gym context)\n\n## Prereqs\nComfort on top rope and basic belay competency.\n',
  '["class","anchors","intermediate"]','2026-02-01T00:00:00Z','2026-02-01T00:00:00Z'
),
(
  'doc_cdef_lead_101_en','class_definition','cdef_lead_101','en','Lead Climbing 101','lead-101',
  '# Lead Climbing 101\n\nLearn lead belay and lead climbing fundamentals in a controlled setting.\n\n## Includes\n- lead belay technique\n- clipping positions\n- fall factors basics\n- gym lead safety norms\n\n## Prereqs\nTop rope belay competency.\n',
  '["class","lead","intermediate"]','2026-02-01T00:00:00Z','2026-02-01T00:00:00Z'
),
(
  'doc_cdef_fall_practice_en','class_definition','cdef_fall_practice','en','Falling Practice Workshop','falling-practice',
  '# Falling Practice\n\nA practical workshop to build safe falling confidence.\n\n## Focus\n- soft catches\n- progressive fall drills\n- mindset tools\n\n## Notes\nWe only do drills appropriate for your experience.\n',
  '["class","lead","confidence"]','2026-02-01T00:00:00Z','2026-02-01T00:00:00Z'
),
(
  'doc_cdef_movement_lab_en','class_definition','cdef_movement_lab','en','Movement Lab','movement-lab',
  '# Movement Lab\n\nFootwork, balance, and efficient body positions.\n\n## You''ll practice\n- quiet feet\n- hip positioning\n- basic flagging\n- pacing and resting\n',
  '["class","movement","beginner"]','2026-02-01T00:00:00Z','2026-02-01T00:00:00Z'
),
(
  'doc_cdef_outdoor_access_en','class_definition','cdef_outdoor_access','en','Outdoor Wall Access (Weather-Dependent)','outdoor-wall-access',
  '# Outdoor Wall Access\n\nA supervised session on our outdoor wall.\n\n## Weather dependence\nWe may modify or cancel for lightning, high winds, precipitation, or icy surfaces.\n\n## Recommended\nBring layers and a wind shell.\n',
  '["class","outdoor","weather"]','2026-02-01T00:00:00Z','2026-02-01T00:00:00Z'
),
(
  'doc_cdef_private_coaching_en','class_definition','cdef_private_coaching_60','en','Private Coaching (60 min)','private-coaching-60',
  '# Private Coaching (60 min)\n\nA 1:1 session tailored to your goals.\n\n## Common goals\n- first lead\n- bouldering tactics\n- footwork + efficiency\n- strength plan and drills\n\n## Outcome\nYou leave with a short plan you can repeat.\n',
  '["class","private","coaching"]','2026-02-01T00:00:00Z','2026-02-01T00:00:00Z'
),
(
  'doc_cdef_private_lead_en','class_definition','cdef_private_lead_60','en','Private Lead Tune-Up (60 min)','private-lead-tuneup',
  '# Private Lead Tune-Up\n\nA focused 1:1 for sharper clipping, pacing, and head game.\n\n## Good for\n- first outdoor sport trip prep\n- breaking through “pump panic”\n- dialing lead belay habits\n',
  '["class","private","lead"]','2026-02-01T00:00:00Z','2026-02-01T00:00:00Z'
)
ON CONFLICT(entity_type, entity_id, locale) DO UPDATE SET body_markdown=excluded.body_markdown, updated_at_iso=excluded.updated_at_iso;

-- Product descriptions (entity_id uses core products.sku)
INSERT INTO content_docs (doc_id, entity_type, entity_id, locale, title, slug, body_markdown, tags_json, created_at_iso, updated_at_iso) VALUES
('doc_prod_access_day_pass_en','product','access_day_pass','en','Day Pass (All Day)','day-pass',
'# Day Pass\n\nAll-day access to bouldering + ropes areas during staffed hours.\n\n## Includes\n- facility access\n\n## Does not include\n- rentals\n- instruction\n','["product","access"]','2026-02-01T00:00:00Z','2026-02-01T00:00:00Z'),
('doc_prod_access_5_visit_en','product','access_5_visit_punch','en','5-Visit Punch Pass','5-visit-pass',
'# 5-Visit Punch Pass\n\nFlexible visits for people who climb a couple times a month.\n\n## Notes\nPunch passes are not transferable.\n','["product","access"]','2026-02-01T00:00:00Z','2026-02-01T00:00:00Z'),
('doc_prod_memb_individual_en','product','memb_monthly_individual','en','Monthly Membership (Individual)','membership-individual',
'# Monthly Membership\n\nUnlimited access + member perks.\n\n## Perks\n- discounts on classes\n- priority booking windows (when available)\n- guest day-pass discount\n','["product","membership"]','2026-02-01T00:00:00Z','2026-02-01T00:00:00Z'),
('doc_prod_rental_shoes_en','product','rental_shoes_day','en','Shoe Rental (Day)','shoe-rental',
'# Shoe Rental\n\nAll-day shoe rental.\n\n## Fit help\nAsk staff for sizing—snug but not painful.\n','["product","rental"]','2026-02-01T00:00:00Z','2026-02-01T00:00:00Z'),
('doc_prod_class_intro_belay_en','product','class_intro_belay','en','Class: Intro to Belay','class-intro-belay',
'# Intro to Belay (Purchase)\n\nThis SKU represents purchasing a spot in the Intro to Belay class.\n\nYou will still need to select a scheduled session time.\n','["product","class","belay"]','2026-02-01T00:00:00Z','2026-02-01T00:00:00Z'),
('doc_prod_private_60_en','product','coaching_private_60','en','Private Coaching: 60 minutes','private-coaching',
'# Private Coaching (60)\n\n1:1 coaching session.\n\n## Scheduling\nWe match you with an instructor based on goals and availability.\n','["product","coaching","private"]','2026-02-01T00:00:00Z','2026-02-01T00:00:00Z')
ON CONFLICT(entity_type, entity_id, locale) DO UPDATE SET body_markdown=excluded.body_markdown, updated_at_iso=excluded.updated_at_iso;

