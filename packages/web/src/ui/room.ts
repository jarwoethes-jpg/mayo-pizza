/** Returns the server value for a password draft, treating blank input as open. */
export const normalizeRoomPassword = (draft: string): string | undefined => {
  const normalized = draft.trim();
  return normalized === "" ? undefined : normalized;
};

/** Builds a share URL from only the room capability slug. */
export const makeRoomShareUrl = (origin: string, slug: string): string =>
  new URL(`/${encodeURIComponent(slug)}`, origin).toString();
