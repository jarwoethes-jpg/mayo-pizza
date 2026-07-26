import { describe, expect, it } from "vitest";
import {
  createRoomRegistry,
  generateSlug,
  PIZZA_WORDLIST,
  ROOM_TTL_MS,
  reapIdleRooms,
} from "../src/rooms.js";

describe("pizza room registry", () => {
  it("uses a 40-bit-plus pizza slug space", () => {
    expect(PIZZA_WORDLIST).toHaveLength(4096);
    expect(Math.log2(PIZZA_WORDLIST.length ** 3 * 100)).toBeGreaterThanOrEqual(
      40,
    );
    expect(generateSlug()).toMatch(/^[a-z]+-[a-z]+-[a-z]+-\d{2}$/);
  });

  it("reaps rooms idle beyond the 30-minute TTL", () => {
    const now = 1_700_000_000_000;
    const registry = createRoomRegistry({ now: () => now, startReaper: false });
    const room = registry.createRoom("uploader-1");

    expect(registry.rooms.has(room.slug)).toBe(true);
    expect(reapIdleRooms(registry, now + ROOM_TTL_MS + 1)).toBe(1);
    expect(registry.rooms.has(room.slug)).toBe(false);
  });

  it("keeps empty rooms alive for uploader token rejoin until the TTL reaper", () => {
    const now = 1_700_000_000_000;
    const registry = createRoomRegistry({ now: () => now, startReaper: false });
    const room = registry.createRoom("uploader-1", undefined, "token-1");
    const socket = { close: () => undefined } as never;

    registry.addPeer(room, "uploader-1", socket);
    registry.removePeer(room, "uploader-1");

    expect(registry.rooms.has(room.slug)).toBe(true);
    expect(room.uploaderToken).toBe("token-1");
    expect(reapIdleRooms(registry, now + ROOM_TTL_MS + 1)).toBe(1);
    expect(registry.rooms.has(room.slug)).toBe(false);
  });
});
