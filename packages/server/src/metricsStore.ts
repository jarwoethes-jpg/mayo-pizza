import { randomUUID } from "node:crypto";
import {
  readFileSync as nodeReadFileSync,
  renameSync as nodeRenameSync,
  unlinkSync as nodeUnlinkSync,
  writeFileSync as nodeWriteFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { RateLimitAction } from "./ratelimit.js";

export interface MetricsState {
  roomsCreated: number;
  roomsReaped: number;
  passwordFailures: number;
  tokenFailures: number;
  roomsLocked: number;
  malformed: number;
  rateLimited: Record<RateLimitAction, number>;
  connections: Record<"direct" | "relay", number>;
  connectionFailures: Record<"ice" | "connection", number>;
}

interface MetricsSnapshot {
  version: 1;
  counters: MetricsState;
}

export interface MetricsStoreFileSystem {
  readFileSync: (path: string, encoding: "utf8") => string;
  writeFileSync: (
    path: string,
    data: string,
    options: { encoding: "utf8"; mode: number },
  ) => void;
  renameSync: (oldPath: string, newPath: string) => void;
  unlinkSync: (path: string) => void;
}

const nodeFileSystem: MetricsStoreFileSystem = {
  readFileSync: (path, encoding) => nodeReadFileSync(path, encoding),
  writeFileSync: (path, data, options) =>
    nodeWriteFileSync(path, data, options),
  renameSync: (oldPath, newPath) => nodeRenameSync(oldPath, newPath),
  unlinkSync: (path) => nodeUnlinkSync(path),
};

export interface MetricsStoreOptions {
  fileSystem?: MetricsStoreFileSystem;
  log?: (message: string) => void;
}

export interface MetricsStore {
  load: () => MetricsState;
  flush: (metrics: MetricsState) => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isCounter = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isMetricsState = (value: unknown): value is MetricsState =>
  isRecord(value) &&
  isCounter(value.roomsCreated) &&
  isCounter(value.roomsReaped) &&
  isCounter(value.passwordFailures) &&
  isCounter(value.tokenFailures) &&
  isCounter(value.roomsLocked) &&
  isCounter(value.malformed) &&
  isRecord(value.rateLimited) &&
  isCounter(value.rateLimited.create) &&
  isCounter(value.rateLimited.join) &&
  isCounter(value.rateLimited.message) &&
  isRecord(value.connections) &&
  isCounter(value.connections.direct) &&
  isCounter(value.connections.relay) &&
  isRecord(value.connectionFailures) &&
  isCounter(value.connectionFailures.ice) &&
  isCounter(value.connectionFailures.connection);

const isMetricsSnapshot = (value: unknown): value is MetricsSnapshot =>
  isRecord(value) && value.version === 1 && isMetricsState(value.counters);

const toPersistedMetrics = (metrics: MetricsState): MetricsState => ({
  roomsCreated: metrics.roomsCreated,
  roomsReaped: metrics.roomsReaped,
  passwordFailures: metrics.passwordFailures,
  tokenFailures: metrics.tokenFailures,
  roomsLocked: metrics.roomsLocked,
  malformed: metrics.malformed,
  rateLimited: {
    create: metrics.rateLimited.create,
    join: metrics.rateLimited.join,
    message: metrics.rateLimited.message,
  },
  connections: {
    direct: metrics.connections.direct,
    relay: metrics.connections.relay,
  },
  connectionFailures: {
    ice: metrics.connectionFailures.ice,
    connection: metrics.connectionFailures.connection,
  },
});

const defaultLog = (message: string): void => {
  console.error(message);
};

/** Creates a zeroed metrics state for a fresh process or invalid snapshot. */
export const createMetricsState = (): MetricsState => ({
  roomsCreated: 0,
  roomsReaped: 0,
  passwordFailures: 0,
  tokenFailures: 0,
  roomsLocked: 0,
  malformed: 0,
  rateLimited: { create: 0, join: 0, message: 0 },
  connections: { direct: 0, relay: 0 },
  connectionFailures: { ice: 0, connection: 0 },
});

// WHY: this intentionally supports one app container only; a JSON file is not multi-instance safe.
/** Persists the single-container monotonic metrics counters as an atomic JSON snapshot. */
export const createMetricsStore = (
  filePath: string,
  options: MetricsStoreOptions = {},
): MetricsStore => {
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  const log = options.log ?? defaultLog;
  const reportFailure = (operation: string, error: unknown): void => {
    const detail = error instanceof Error ? error.message : String(error);
    try {
      log(`[metrics-store] ${operation} ${filePath}: ${detail}`);
    } catch {
      // Metrics diagnostics must not fail the signaling server if logging is unavailable.
    }
  };

  return {
    load: () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(
          fileSystem.readFileSync(filePath, "utf8"),
        ) as unknown;
      } catch (error) {
        reportFailure("could not load snapshot", error);
        return createMetricsState();
      }

      if (!isMetricsSnapshot(parsed)) {
        reportFailure(
          "could not load snapshot",
          new Error("invalid snapshot format"),
        );
        return createMetricsState();
      }

      return toPersistedMetrics(parsed.counters);
    },
    flush: (metrics) => {
      const temporaryPath = join(
        dirname(filePath),
        `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
      );
      try {
        const snapshot: MetricsSnapshot = {
          version: 1,
          counters: toPersistedMetrics(metrics),
        };
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
