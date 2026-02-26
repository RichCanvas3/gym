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

export type GymAssistantResult = {
  answer: string;
  citations: Citation[];
  opsFreshness?: OpsFreshness;
  weatherFreshness?: WeatherFreshness;
  suggestedCartItems?: CartItemSuggestion[];
};

export type GymAssistantSession = {
  gymName?: string;
  timezone?: string;
  userName?: string;
  userGoals?: string;
};

