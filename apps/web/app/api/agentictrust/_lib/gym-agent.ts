export const GYM_AGENT_LABEL_SUFFIX = "-gym";
export const GYM_AGENT_NAME_SUFFIX = "-gym.8004-agent.eth";

export function safeBaseName(value: unknown): string {
  const s = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!s) return "";
  if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/i.test(s)) return "";
  return s;
}

export function gymAgentLabelFromBaseName(baseName: string): string {
  return `${baseName}${GYM_AGENT_LABEL_SUFFIX}`;
}

export function gymAgentNameFromBaseName(baseName: string): string {
  return `${gymAgentLabelFromBaseName(baseName)}.8004-agent.eth`;
}

export function baseNameFromGymAgentName(agentName: string): string | null {
  const s = String(agentName ?? "").trim().toLowerCase();
  if (!s.endsWith(GYM_AGENT_NAME_SUFFIX)) return null;
  const base = s.slice(0, -GYM_AGENT_NAME_SUFFIX.length);
  return safeBaseName(base) || null;
}

export function gymAgentLabelFromAgentName(agentName: string): string | null {
  const baseName = baseNameFromGymAgentName(agentName);
  return baseName ? gymAgentLabelFromBaseName(baseName) : null;
}

export function nameCandidatesFromAgentRecord(ar: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v !== "string") return;
    const s = v.trim();
    if (!s) return;
    out.push(s);
  };

  push(ar.agentName);
  push(ar.name);
  push(ar.ensName);
  push(ar.ens_name);
  push(ar.identityEnsDid);

  const identities = ar.identities as unknown;
  if (Array.isArray(identities)) {
    for (const id of identities) {
      if (!id || typeof id !== "object") continue;
      const ir = id as Record<string, unknown>;
      push(ir.agentName);
      push(ir.name);
      push(ir.ensName);
      push(ir.ens_name);
      push(ir.did);
      push(ir.didIdentity);
      push(ir.identityEnsDid);
      const did = typeof ir.did === "string" ? ir.did.trim() : "";
      if (did.toLowerCase().startsWith("did:ens:")) {
        push(did.slice("did:ens:".length));
      }
    }
  }

  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const s of out) {
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(s);
  }
  return deduped;
}
