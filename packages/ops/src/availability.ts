import type {
  Camp,
  CampAvailability,
  ClassAvailability,
  Coach,
  GymClass,
  Product,
  ProductAvailability,
} from "./types";
import {
  baseCatalog,
  campEnrollments,
  camps,
  classEnrollments,
  classes,
  coaches,
  productAvailability,
} from "./data";

export type OpsResult<T> = {
  data: T;
  asOfISO: string;
};

function asOfISO() {
  return new Date().toISOString();
}

export function getProductAvailability(input: {
  sku: string;
  size?: string;
}): OpsResult<ProductAvailability | null> {
  const match = productAvailability.find((p) => {
    if (p.sku !== input.sku) return false;
    if (input.size == null) return p.size == null;
    return p.size === input.size;
  });
  return { data: match ?? null, asOfISO: asOfISO() };
}

export function getClassAvailability(input: {
  classId: string;
}): OpsResult<ClassAvailability | null> {
  const gymClass = classes.find((c) => c.id === input.classId);
  if (!gymClass) return { data: null, asOfISO: asOfISO() };
  const enrolled = classEnrollments[gymClass.id] ?? 0;
  const seatsLeft = Math.max(0, gymClass.capacity - enrolled);
  return {
    data: {
      classId: gymClass.id,
      capacity: gymClass.capacity,
      enrolled,
      seatsLeft,
    },
    asOfISO: asOfISO(),
  };
}

export function searchClasses(input: {
  dateISO?: string; // YYYY-MM-DD, optional
  skillLevel?: GymClass["skillLevel"];
  type?: GymClass["type"];
}): OpsResult<GymClass[]> {
  const out = classes.filter((c) => {
    if (input.type && c.type !== input.type) return false;
    if (input.skillLevel && c.skillLevel !== input.skillLevel) return false;
    if (input.dateISO) {
      // compare by prefix; startTimeISO includes tz offset
      const startDate = c.startTimeISO.slice(0, 10);
      if (startDate !== input.dateISO) return false;
    }
    return true;
  });
  return { data: out, asOfISO: asOfISO() };
}

export function searchCoaches(input: { skillIdOrName: string }): OpsResult<Coach[]> {
  const needle = input.skillIdOrName.trim().toLowerCase();
  const out = coaches.filter((c) =>
    c.skills.some(
      (s) => s.id.toLowerCase() === needle || s.name.toLowerCase().includes(needle),
    ),
  );
  return { data: out, asOfISO: asOfISO() };
}

export function listCatalog(): OpsResult<Product[]> {
  return { data: getFullCatalog(), asOfISO: asOfISO() };
}

export function getCatalogItem(input: { sku: string }): OpsResult<Product | null> {
  const item = getFullCatalog().find((p) => p.sku === input.sku) ?? null;
  return { data: item, asOfISO: asOfISO() };
}

export function searchCatalog(input: { query: string; limit?: number }): OpsResult<Product[]> {
  const q = input.query.trim().toLowerCase();
  const limit = input.limit ?? 8;
  const out = getFullCatalog()
    .filter((p) => {
      const hay = `${p.sku} ${p.name} ${p.category} ${p.description ?? ""}`.toLowerCase();
      return hay.includes(q);
    })
    .slice(0, limit);
  return { data: out, asOfISO: asOfISO() };
}

export function listCamps(): OpsResult<Camp[]> {
  return { data: camps, asOfISO: asOfISO() };
}

export function getCampAvailability(input: { campId: string }): OpsResult<CampAvailability | null> {
  const camp = camps.find((c) => c.id === input.campId);
  if (!camp) return { data: null, asOfISO: asOfISO() };
  const enrolled = campEnrollments[camp.id] ?? 0;
  const seatsLeft = Math.max(0, camp.capacity - enrolled);
  return {
    data: { campId: camp.id, capacity: camp.capacity, enrolled, seatsLeft },
    asOfISO: asOfISO(),
  };
}

function getFullCatalog(): Product[] {
  return [...baseCatalog, ...classes.map(classToCatalogItem)];
}

export function makeClassRegistrationSku(classId: string) {
  return `CLASSREG_${classId}`;
}

function classToCatalogItem(c: GymClass): Product {
  const when = c.startTimeISO.replace("T", " ").replace(/:00([+-]\d\d:\d\d)$/, "$1");
  const priceCents = c.type === "private" ? 9000 : 3500;
  return {
    sku: makeClassRegistrationSku(c.id),
    name: `Class Registration: ${c.title}`,
    category: "class",
    description: `Register 1 person for ${c.title}. Starts ${when}.`,
    priceCents,
    currency: "USD",
    requiresFacilityAccess: true,
    includes: ["class_registration", c.id],
  };
}

