import {
  getClassAvailability,
  getCatalogItem,
  getProductAvailability,
  listCatalog,
  searchCatalog,
  searchClasses,
  searchCoaches,
} from "@climb-gym/ops";

export type OpsToolResult = {
  asOfISO: string;
  endpoint: string;
  payload: unknown;
};

export function opsProductAvailability(input: { sku: string; size?: string }): OpsToolResult {
  const res = getProductAvailability(input);
  return { asOfISO: res.asOfISO, endpoint: "products/availability", payload: res.data };
}

export function opsClassAvailability(input: { classId: string }): OpsToolResult {
  const res = getClassAvailability(input);
  return { asOfISO: res.asOfISO, endpoint: "classes/availability", payload: res.data };
}

export function opsSearchClasses(input: {
  dateISO?: string;
  skillLevel?: "beginner" | "intermediate" | "advanced";
  type?: "group" | "private";
}): OpsToolResult {
  const res = searchClasses(input);
  return { asOfISO: res.asOfISO, endpoint: "classes/search", payload: res.data };
}

export function opsSearchCoaches(input: { skillIdOrName: string }): OpsToolResult {
  const res = searchCoaches(input);
  return { asOfISO: res.asOfISO, endpoint: "coaches/search", payload: res.data };
}

export function opsListCatalog(): OpsToolResult {
  const res = listCatalog();
  return { asOfISO: res.asOfISO, endpoint: "catalog/list", payload: res.data };
}

export function opsSearchCatalog(input: { query: string; limit?: number }): OpsToolResult {
  const res = searchCatalog(input);
  return { asOfISO: res.asOfISO, endpoint: "catalog/search", payload: res.data };
}

export function opsGetCatalogItem(input: { sku: string }): OpsToolResult {
  const res = getCatalogItem(input);
  return { asOfISO: res.asOfISO, endpoint: "catalog/item", payload: res.data };
}

