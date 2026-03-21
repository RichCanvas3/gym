import type { GymAssistantSession } from "../types/domain";

export function buildSessionPrompt(session?: GymAssistantSession) {
  const gymName = session?.gymName ?? "Erie Community Center";
  const timezone = session?.timezone ?? "America/Denver";
  const userName = session?.userName;
  const userGoals = session?.userGoals;
  const cartLines = session?.cartLines ?? [];
  const waiver = session?.waiver;

  const lines = [
    `Gym: ${gymName}`,
    `Timezone: ${timezone}`,
  ];
  if (userName) lines.push(`UserName: ${userName}`);
  if (userGoals) lines.push(`UserGoals: ${userGoals}`);
  if (waiver?.id) {
    lines.push(
      `WaiverOnFile: yes (id=${waiver.id}, accountAddress=${waiver.accountAddress}, participant=${waiver.participantName}${
        waiver.participantEmail ? `, email=${waiver.participantEmail}` : ""
      }, minor=${waiver.isMinor})`,
    );
  } else {
    lines.push("WaiverOnFile: unknown");
  }
  if (cartLines.length) {
    lines.push(
      `Cart: ${cartLines
        .slice(0, 25)
        .map((l) => `${l.sku} x${l.quantity}`)
        .join(", ")}`,
    );
  } else {
    lines.push("Cart: empty");
  }
  return lines.join("\n");
}

