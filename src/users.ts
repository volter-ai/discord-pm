/**
 * Team member registry — maps GitHub usernames to display names and
 * (optionally) Discord user IDs.
 *
 * Participants for every standup are derived from GitHub (who has open
 * assigned issues); this registry lets the Activity render friendly display
 * names and reliably mark people "not present" when their Discord ID isn't
 * in the voice channel.
 *
 * A missing entry is fine — the Activity falls back to the GitHub username
 * and a fuzzy display-name match. Fill in `discordId` over time to make
 * not-present detection airtight.
 */

export interface UserMapping {
  displayName: string;
  /** Discord user ID. Populate for reliable voice-presence matching. */
  discordId?: string;
}

/** Keyed by GitHub username (lowercased on lookup). */
export const USERS: Record<string, UserMapping> = {
  brunoccpires: { displayName: "Bruno" },
  "oliver-io": { displayName: "Oliver" },
  bouscs: { displayName: "Artur" },
  "brennan-volter": { displayName: "Brennan" },
  careid: { displayName: "Chris" },
  edmundmtang: { displayName: "Edmund" },
  mococa: { displayName: "Luiz" },
};

export function lookupUser(githubUser: string): UserMapping | undefined {
  return USERS[githubUser.toLowerCase()];
}

export function resolveDisplayName(githubUser: string): string {
  return lookupUser(githubUser)?.displayName ?? githubUser;
}

/** Reverse lookup: find the GitHub username (if any) for a Discord user ID. */
export function githubUserForDiscordId(discordId: string): string | null {
  for (const [gh, mapping] of Object.entries(USERS)) {
    if (mapping.discordId === discordId) return gh;
  }
  return null;
}
