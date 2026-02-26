import type { Camp, Coach, GymClass, Product, ProductAvailability } from "./types";

export const coaches: Coach[] = [
  {
    id: "coach_maya",
    name: "Maya Thompson",
    skills: [
      { id: "bouldering_fundamentals", name: "Bouldering Fundamentals", level: "expert" },
      { id: "injury_prevention", name: "Injury Prevention", level: "coach" },
    ],
    bio: "Movement-focused coach with an emphasis on sustainable training.",
  },
  {
    id: "coach_jordan",
    name: "Jordan Lee",
    skills: [
      { id: "top_rope_basics", name: "Top Rope Basics", level: "expert" },
      { id: "lead_progression", name: "Lead Progression", level: "coach" },
      { id: "belay_instruction", name: "Belay Instruction", level: "expert" },
    ],
    bio: "Helps new leaders build safe, confident habits.",
  },
  {
    id: "coach_sam",
    name: "Sam Rivera",
    skills: [
      { id: "youth_coaching", name: "Youth Coaching", level: "expert" },
      { id: "group_facilitation", name: "Group Facilitation", level: "coach" },
      { id: "safety_systems", name: "Safety Systems", level: "coach" },
    ],
    bio: "Great with groups and first-time climbers; safety-first communication.",
  },
];

export const classes: GymClass[] = [
  {
    id: "class_boulder_fundamentals_001",
    title: "Bouldering Fundamentals",
    type: "group",
    skillLevel: "beginner",
    coachId: "coach_maya",
    startTimeISO: "2026-03-02T18:00:00-07:00",
    durationMinutes: 75,
    capacity: 10,
  },
  {
    id: "class_top_rope_basics_001",
    title: "Top Rope Basics",
    type: "group",
    skillLevel: "beginner",
    coachId: "coach_jordan",
    startTimeISO: "2026-03-03T18:30:00-07:00",
    durationMinutes: 90,
    capacity: 8,
  },
  {
    id: "class_lead_belay_001",
    title: "Lead Climbing + Belay",
    type: "group",
    skillLevel: "intermediate",
    coachId: "coach_jordan",
    startTimeISO: "2026-03-05T19:00:00-07:00",
    durationMinutes: 120,
    capacity: 6,
  },
  {
    id: "class_private_coaching_001",
    title: "Private Coaching (1:1)",
    type: "private",
    skillLevel: "beginner",
    coachId: "coach_maya",
    startTimeISO: "2026-03-04T17:00:00-07:00",
    durationMinutes: 60,
    capacity: 1,
  },
  {
    id: "class_outdoor_wall_intro_001",
    title: "Outdoor Wall Intro + Safety",
    type: "group",
    skillLevel: "beginner",
    coachId: "coach_sam",
    startTimeISO: "2026-03-06T16:30:00-07:00",
    durationMinutes: 60,
    capacity: 10,
  },
  {
    id: "class_outdoor_lead_clinic_001",
    title: "Outdoor Lead Skills Clinic",
    type: "group",
    skillLevel: "intermediate",
    coachId: "coach_jordan",
    startTimeISO: "2026-03-07T10:00:00-07:00",
    durationMinutes: 120,
    capacity: 6,
  },
];

export const products: Product[] = [
  {
    sku: "DAY_PASS",
    name: "Day Pass",
    category: "day_pass",
    description: "Single-day facility access.",
    priceCents: 2500,
    currency: "USD",
    includes: ["facility_access"],
  },
  {
    sku: "ACCESS_5PACK",
    name: "5-Pack Day Passes",
    category: "pack",
    description: "Five visits at a discount.",
    priceCents: 11000,
    currency: "USD",
    includes: ["facility_access_x5"],
  },
  {
    sku: "MEMBERSHIP_ALL_ACCESS_MONTHLY",
    name: "All-Access Monthly Membership",
    category: "membership",
    description: "Facility access + lockers + usage of shared equipment.",
    priceCents: 8900,
    currency: "USD",
    includes: ["facility_access", "lockers", "shared_equipment_use"],
  },
  {
    sku: "COACHING_PRIVATE_60",
    name: "Private Coaching (60 minutes)",
    category: "service",
    description: "One-hour 1:1 coaching session. Requires separate facility access.",
    priceCents: 9000,
    currency: "USD",
    requiresFacilityAccess: true,
    includes: ["coaching_60min"],
  },
  {
    sku: "RENTAL_SHOE",
    name: "Rental Climbing Shoes",
    category: "rental",
    description: "Rental shoes (size-based availability).",
    priceCents: 600,
    currency: "USD",
    requiresFacilityAccess: true,
  },
  {
    sku: "RENTAL_HARNESS",
    name: "Rental Harness",
    category: "rental",
    description: "Rental harness.",
    priceCents: 500,
    currency: "USD",
    requiresFacilityAccess: true,
  },
  {
    sku: "CHALK_200G",
    name: "Loose Chalk (200g)",
    category: "chalk",
    description: "Retail chalk bag.",
    priceCents: 1499,
    currency: "USD",
  },
  {
    sku: "TAPE_ATHLETIC",
    name: "Athletic Tape",
    category: "accessory",
    description: "Basic athletic tape for finger care.",
    priceCents: 599,
    currency: "USD",
  },
];

export const camps: Camp[] = [
  {
    id: "camp_spring_break_2026",
    sku: "CAMP_SPRING_BREAK_2026",
    title: "Spring Break Climbing Camp",
    startDateISO: "2026-03-23",
    endDateISO: "2026-03-27",
    dailyStartTimeLocal: "09:00",
    dailyDurationMinutes: 360,
    includesLunch: true,
    parentsPresent: false,
    capacity: 18,
  },
];

export const campProduct: Product = {
  sku: "CAMP_SPRING_BREAK_2026",
  name: "Spring Break Climbing Camp (Mar 23–27)",
  category: "camp",
  description: "Daily instruction + lunch. Parents not present. Weather may affect outdoor components.",
  priceCents: 42500,
  currency: "USD",
  requiresFacilityAccess: false,
  includes: ["camp_instruction", "lunch"],
};

export const baseCatalog: Product[] = [...products, campProduct];

// Simple availability store (pretend this is real-time inventory)
export const productAvailability: ProductAvailability[] = [
  { sku: "RENTAL_SHOE", size: "10", inStock: true, quantity: 4 },
  { sku: "RENTAL_SHOE", size: "11", inStock: true, quantity: 2 },
  { sku: "RENTAL_SHOE", size: "12", inStock: false, quantity: 0 },
  { sku: "RENTAL_HARNESS", inStock: true, quantity: 7 },
  { sku: "CHALK_200G", inStock: true, quantity: 18 },
  { sku: "DAY_PASS", inStock: true, quantity: 9999 },
  { sku: "ACCESS_5PACK", inStock: true, quantity: 9999 },
  { sku: "MEMBERSHIP_ALL_ACCESS_MONTHLY", inStock: true, quantity: 9999 },
  { sku: "COACHING_PRIVATE_60", inStock: true, quantity: 9999 },
  { sku: "CAMP_SPRING_BREAK_2026", inStock: true, quantity: 12 },
];

// Enrollment (pretend this changes in real time)
export const classEnrollments: Record<string, number> = {
  class_boulder_fundamentals_001: 7,
  class_top_rope_basics_001: 8,
  class_lead_belay_001: 3,
  class_private_coaching_001: 1,
  class_outdoor_wall_intro_001: 5,
  class_outdoor_lead_clinic_001: 2,
};

export const campEnrollments: Record<string, number> = {
  camp_spring_break_2026: 9,
};

