import type { GymAssistantSession } from "../types/domain";

export function buildSessionPrompt(session?: GymAssistantSession) {
  const gymName = session?.gymName ?? "Front Range Climbing (Boulder)";
  const timezone = session?.timezone ?? "America/Denver";
  const userName = session?.userName;
  const userGoals = session?.userGoals;

  const lines = [
    `Gym: ${gymName}`,
    `Timezone: ${timezone}`,
  ];
  if (userName) lines.push(`UserName: ${userName}`);
  if (userGoals) lines.push(`UserGoals: ${userGoals}`);
  return lines.join("\n");
}

