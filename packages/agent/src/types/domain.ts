export type Citation = {
  sourceId: string; // e.g. "policies/waiver.md"
  snippet: string;
};

export type OpsFreshness = {
  asOfISO: string;
  endpoints: string[];
};

export type WeatherFreshness = {
  asOfISO: string;
  locationLabel: string;
};

export type CartItemSuggestion = {
  sku: string;
  quantity: number;
  note?: string;
};

export type CartAction = {
  op: "add" | "remove" | "clear";
  sku?: string;
  quantity?: number;
  note?: string;
};

export type UiAction = {
  type: "navigate";
  to: "/waiver" | "/cart" | "/shop" | "/chat" | "/calendar";
  reason?: string;
};

export type GymAssistantResult = {
  answer: string;
  citations: Citation[];
  opsFreshness?: OpsFreshness;
  weatherFreshness?: WeatherFreshness;
  suggestedCartItems?: CartItemSuggestion[];
  cartActions?: CartAction[];
  uiActions?: UiAction[];
};

export type GymAssistantSession = {
  gymName?: string;
  timezone?: string;
  userName?: string;
  userGoals?: string;
  cartLines?: Array<{ sku: string; quantity: number }>;
  waiver?: { id: string; accountAddress: string; participantName: string; participantEmail?: string; isMinor: boolean };
};

