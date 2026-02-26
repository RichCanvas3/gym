export type Skill = {
  id: string;
  name: string;
  level?: "assistant" | "coach" | "expert";
};

export type Coach = {
  id: string;
  name: string;
  skills: Skill[];
  bio: string;
};

export type GymClass = {
  id: string;
  title: string;
  type: "group" | "private";
  skillLevel: "beginner" | "intermediate" | "advanced";
  coachId: string;
  startTimeISO: string;
  durationMinutes: number;
  capacity: number;
};

export type ClassAvailability = {
  classId: string;
  capacity: number;
  enrolled: number;
  seatsLeft: number;
};

export type ProductCategory =
  | "shoes"
  | "chalk"
  | "harness"
  | "accessory"
  | "membership"
  | "day_pass"
  | "rental"
  | "service"
  | "pack"
  | "class"
  | "camp";

export type Product = {
  sku: string;
  name: string;
  category: ProductCategory;
  description?: string;
  priceCents: number;
  currency: "USD";
  // If true, customer must also have day-pass or membership for entry.
  requiresFacilityAccess?: boolean;
  includes?: string[];
};

export type ProductAvailability = {
  sku: string;
  size?: string;
  inStock: boolean;
  quantity: number;
};

export type Camp = {
  id: string;
  sku: string; // purchasable sku
  title: string;
  startDateISO: string; // YYYY-MM-DD
  endDateISO: string; // YYYY-MM-DD
  dailyStartTimeLocal: string; // HH:MM
  dailyDurationMinutes: number;
  includesLunch: boolean;
  parentsPresent: false;
  capacity: number;
};

export type CampAvailability = {
  campId: string;
  capacity: number;
  enrolled: number;
  seatsLeft: number;
};

