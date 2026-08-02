import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoomStore } from "../src/roomStore.js";
import { createRoomRegistry, reapIdleRooms } from "../src/rooms.js";

const tempDirectories: string[] = [];

const makeTempDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "mayo-room-store-"));
  tempDirectories.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("room snapshot store", () => {
  it("round-trips every persisted room field with no live peers or plaintext token", () => {
    const directory = makeTempDirectory();
    const statePath = join(directory, "rooms.json");
    const now = 1_700_000_000_000;
    const registry = createRoomRegistry({
      now: () => now,
      startReaper: false,
      statePath,
    });
    const room = registry.createRoom(
      "uploader-before",
      "password-hash",
      "token-1",
    );
    room.uploaderId = "uploader-after";
    room.lastSeenAt = now + 123;
    room.passwordFailures = 2;
    room.tokenFailures = 3;
    room.lockedAt = now + 100;
    room.peers.set("live-peer", {} as never);
    registry.flush();

    const serialized = readFileSync(statePath, "utf8");
    expect(serialized).not.toContain("token-1");

    const restored = createRoomRegistry({
      now: () => now + 200,
      startReaper: false,
      statePath,
    });
    const restoredRoom = restored.getRoom(room.slug);

    expect(restoredRoom).toMatchObject({
      slug: room.slug,
      uploaderId: "uploader-after",
      uploaderTokenHash: createHash("sha256").update("token-1").digest("hex"),
      passwordHash: "password-hash",
      createdAt: now,
      lastSeenAt: now + 123,
      passwordFailures: 2,
      tokenFailures: 3,
      lockedAt: now + 100,
    });
    expect(restoredRoom?.peers).toEqual(new Map());
  });

  it("drops rooms that are past the TTL during load", () => {
    const directory = makeTempDirectory();
    const statePath = join(directory, "rooms.json");
    const now = 1_700_000_000_000;
    const registry = createRoomRegistry({
      now: () => now,
      startReaper: false,
      statePath,
      ttlMs: 1_000,
    });
    const room = registry.createRoom("uploader-1", undefined, "token-1");
    room.lastSeenAt = now - 1_001;
    registry.flush();

    const restored = createRoomRegistry({
      now: () => now,
      startReaper: false,
      statePath,
      ttlMs: 1_000,
    });

    expect(restored.rooms).toEqual(new Map());
  });

  it("still reaps a restored room when it crosses the TTL after boot", () => {
    const directory = makeTempDirectory();
    const statePath = join(directory, "rooms.json");
    const now = 1_700_000_000_000;
    const ttlMs = 1_000;
    const registry = createRoomRegistry({
      now: () => now,
      startReaper: false,
      statePath,
      ttlMs,
    });
    const room = registry.createRoom("uploader-1", undefined, "token-1");
    room.lastSeenAt = now - ttlMs;
    registry.flush();

    const restored = createRoomRegistry({
      now: () => now,
      startReaper: false,
      statePath,
      ttlMs,
    });

    expect(restored.getRoom(room.slug)).toBeDefined();
    expect(reapIdleRooms(restored, now + 1)).toBe(1);
    expect(restored.getRoom(room.slug)).toBeUndefined();
  });

  it.each([
    ["missing file", (_statePath: string) => undefined],
    [
      "malformed JSON",
      (statePath: string) => writeFileSync(statePath, "{broken"),
    ],
  ])("loads an empty registry without throwing for a %s", (_label, prepare) => {
    const directory = makeTempDirectory();
    const statePath = join(directory, "rooms.json");
    prepare(statePath);
    const store = createRoomStore(statePath);
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    expect(() => store.load(1_700_000_000_000, 1_000)).not.toThrow();
    expect(store.load(1_700_000_000_000, 1_000)).toEqual([]);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("loads and flushes without throwing when the state directory is unwritable", () => {
    const directory = makeTempDirectory();
    const blockedDirectory = join(directory, "blocked");
    mkdirSync(blockedDirectory);
    chmodSync(blockedDirectory, 0o500);
    const store = createRoomStore(join(blockedDirectory, "rooms.json"));
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    expect(() => store.flush([])).not.toThrow();
    expect(() => store.load(1_700_000_000_000, 1_000)).not.toThrow();
    errorSpy.mockRestore();
    chmodSync(blockedDirectory, 0o700);
  });

  it("routes persistence failures to the injected logger", () => {
    const log = vi.fn();
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const store = createRoomStore("state/rooms.json", {
      fileSystem: {
        readFileSync: () => "",
        writeFileSync: () => {
          throw new Error("simulated write failure");
        },
        renameSync: () => undefined,
        unlinkSync: () => undefined,
      },
      log,
    });

    try {
      expect(() => store.flush([])).not.toThrow();
      expect(log).toHaveBeenCalledWith(
        "[room-store] could not save snapshot state/rooms.json: simulated write failure",
      );
      expect(errorSpy).not.toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("never exposes a partial target when the temporary write fails", () => {
    const directory = makeTempDirectory();
    const statePath = join(directory, "rooms.json");
    const originalSnapshot = '{"version":1,"rooms":[]}';
    let visibleSnapshot = originalSnapshot;
    let temporarySnapshot: string | undefined;
    const writtenPaths: string[] = [];
    const store = createRoomStore(statePath, {
      fileSystem: {
        readFileSync: () => visibleSnapshot,
        writeFileSync: (path, contents) => {
          writtenPaths.push(path);
          if (path === statePath) {
            visibleSnapshot = contents.slice(
              0,
              Math.max(1, contents.length / 2),
            );
            throw new Error("simulated write interruption");
          }
          temporarySnapshot = contents;
          throw new Error("simulated write interruption");
        },
        renameSync: () => {
          visibleSnapshot = temporarySnapshot ?? visibleSnapshot;
        },
        unlinkSync: () => undefined,
      },
    });
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    expect(() => store.flush([])).not.toThrow();
    expect(visibleSnapshot).toBe(originalSnapshot);
    expect(writtenPaths).toHaveLength(1);
    expect(writtenPaths[0]).not.toBe(statePath);
    errorSpy.mockRestore();
  });
});
