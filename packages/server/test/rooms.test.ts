import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createRoomRegistry,
  generateSlug,
  PIZZA_WORDLIST,
  parseRoomTtlEnv,
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
    expect(room.uploaderTokenHash).toBe(
      createHash("sha256").update("token-1").digest("hex"),
    );
    expect("uploaderToken" in room).toBe(false);
    expect(reapIdleRooms(registry, now + ROOM_TTL_MS + 1)).toBe(1);
    expect(registry.rooms.has(room.slug)).toBe(false);
  });

  it("tracks separate password and uploader-token failures and locks on five", () => {
    const now = 1_700_000_000_000;
    const registry = createRoomRegistry({ now: () => now, startReaper: false });
    const room = registry.createRoom("uploader-1", "hash", "token-1");

    expect(room.passwordFailures).toBe(0);
    expect(room.tokenFailures).toBe(0);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(registry.recordTokenFailure(room)).toBe(false);
    }
    expect(room.tokenFailures).toBe(5);
    expect(room.lockedAt).toBeUndefined();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      expect(registry.recordPasswordFailure(room)).toBe(false);
    }
    expect(room.passwordFailures).toBe(4);
    expect(registry.recordPasswordFailure(room)).toBe(true);
    expect(room.passwordFailures).toBe(5);
    expect(room.lockedAt).toBe(now);
    registry.resetPasswordFailures(room);
    registry.resetTokenFailures(room);
    expect(room.passwordFailures).toBe(0);
    expect(room.tokenFailures).toBe(0);
    expect(room.lockedAt).toBe(now);
  });

  it.each([
    ["1234", 1234],
    [undefined, ROOM_TTL_MS],
    ["", ROOM_TTL_MS],
    ["0", ROOM_TTL_MS],
    ["-1", ROOM_TTL_MS],
    ["1.5", ROOM_TTL_MS],
  ] as const)(
    "parses the room TTL environment override: %s",
    (value, expected) => {
      expect(parseRoomTtlEnv(value, ROOM_TTL_MS)).toBe(expected);
    },
  );

  it("sends an expiry error before closing reaped peers as going away", () => {
    const now = 1_700_000_000_000;
    const events: string[] = [];
    const socket = {
      readyState: 1,
      send: vi.fn((frame: string) => events.push(`send:${frame}`)),
      close: vi.fn((code: number, reason: string) =>
        events.push(`close:${code}:${reason}`),
      ),
    } as never;
    const registry = createRoomRegistry({ now: () => now, startReaper: false });
    const room = registry.createRoom("uploader-1");
    registry.addPeer(room, "uploader-1", socket);

    expect(reapIdleRooms(registry, now + ROOM_TTL_MS + 1)).toBe(1);
    expect(events).toEqual([
      'send:{"t":"error","code":"BAD_SLUG","message":"That room has expired."}',
      "close:1001:Room expired",
    ]);
  });
});
