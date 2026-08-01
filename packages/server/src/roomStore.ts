import { randomUUID } from "node:crypto";
import {
  readFileSync as nodeReadFileSync,
  renameSync as nodeRenameSync,
  unlinkSync as nodeUnlinkSync,
  writeFileSync as nodeWriteFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Room } from "./rooms.js";

type PersistedRoom = Omit<Room, "peers">;

interface RoomSnapshot {
  version: 1;
  rooms: PersistedRoom[];
}

export interface RoomStoreFileSystem {
  readFileSync: (path: string, encoding: "utf8") => string;
  writeFileSync: (
    path: string,
    data: string,
    options: { encoding: "utf8"; mode: number },
  ) => void;
  renameSync: (oldPath: string, newPath: string) => void;
  unlinkSync: (path: string) => void;
}

const nodeFileSystem: RoomStoreFileSystem = {
  readFileSync: (path, encoding) => nodeReadFileSync(path, encoding),
  writeFileSync: (path, data, options) =>
    nodeWriteFileSync(path, data, options),
  renameSync: (oldPath, newPath) => nodeRenameSync(oldPath, newPath),
  unlinkSync: (path) => nodeUnlinkSync(path),
};

export interface RoomStoreOptions {
  fileSystem?: RoomStoreFileSystem;
  log?: (message: string) => void;
}

export interface RoomStore {
  load: (now: number, ttlMs: number) => Room[];
  flush: (rooms: Iterable<Room>) => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isOptionalString = (value: unknown): value is string | undefined =>
  value === undefined || typeof value === "string";

const isPersistedRoom = (value: unknown): value is PersistedRoom =>
  isRecord(value) &&
  typeof value.slug === "string" &&
  typeof value.uploaderId === "string" &&
  isOptionalString(value.uploaderTokenHash) &&
  isOptionalString(value.passwordHash) &&
  typeof value.createdAt === "number" &&
  Number.isFinite(value.createdAt) &&
  typeof value.lastSeenAt === "number" &&
  Number.isFinite(value.lastSeenAt) &&
  typeof value.passwordFailures === "number" &&
  Number.isSafeInteger(value.passwordFailures) &&
  typeof value.tokenFailures === "number" &&
  Number.isSafeInteger(value.tokenFailures) &&
  (value.lockedAt === undefined ||
    (typeof value.lockedAt === "number" && Number.isFinite(value.lockedAt)));

const isRoomSnapshot = (value: unknown): value is RoomSnapshot =>
  isRecord(value) &&
  value.version === 1 &&
  Array.isArray(value.rooms) &&
  value.rooms.every(isPersistedRoom);

const toPersistedRoom = (room: Room): PersistedRoom => ({
  slug: room.slug,
  uploaderId: room.uploaderId,
  ...(room.uploaderTokenHash === undefined
    ? {}
    : { uploaderTokenHash: room.uploaderTokenHash }),
  ...(room.passwordHash === undefined
    ? {}
    : { passwordHash: room.passwordHash }),
  createdAt: room.createdAt,
  lastSeenAt: room.lastSeenAt,
  passwordFailures: room.passwordFailures,
  tokenFailures: room.tokenFailures,
  ...(room.lockedAt === undefined ? {} : { lockedAt: room.lockedAt }),
});

const toRoom = (room: PersistedRoom): Room => ({
  ...room,
  peers: new Map(),
});

const defaultLog = (message: string): void => {
  console.error(message);
};

// WHY: this intentionally supports one app container only; a JSON file is not multi-instance safe.
/** Persists the single-container room registry as an atomic JSON snapshot. */
export const createRoomStore = (
  filePath: string,
  options: RoomStoreOptions = {},
): RoomStore => {
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  const log = options.log ?? defaultLog;
  const reportFailure = (operation: string, error: unknown): void => {
    const detail = error instanceof Error ? error.message : String(error);
    log(`[room-store] ${operation} ${filePath}: ${detail}`);
  };

  return {
    load: (now, ttlMs) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(
          fileSystem.readFileSync(filePath, "utf8"),
        ) as unknown;
      } catch (error) {
        reportFailure("could not load snapshot", error);
        return [];
      }

      if (!isRoomSnapshot(parsed)) {
        reportFailure(
          "could not load snapshot",
          new Error("invalid snapshot format"),
        );
        return [];
      }

      return parsed.rooms
        .filter((room) => now - room.lastSeenAt <= ttlMs)
        .map(toRoom);
    },
    flush: (rooms) => {
      const snapshot: RoomSnapshot = {
        version: 1,
        rooms: Array.from(rooms, toPersistedRoom),
      };
      const temporaryPath = join(
        dirname(filePath),
        `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
      );
      try {
        fileSystem.writeFileSync(temporaryPath, JSON.stringify(snapshot), {
          encoding: "utf8",
          mode: 0o600,
        });
        fileSystem.renameSync(temporaryPath, filePath);
      } catch (error) {
        try {
          fileSystem.unlinkSync(temporaryPath);
        } catch {
          // The temporary file may not have been created; the original snapshot remains authoritative.
        }
        reportFailure("could not save snapshot", error);
      }
    },
  };
};
