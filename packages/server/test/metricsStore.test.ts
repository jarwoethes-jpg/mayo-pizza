import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "../src/index.js";
import {
  createMetricsState,
  createMetricsStore,
  type MetricsState,
  type MetricsStoreFileSystem,
} from "../src/metricsStore.js";

const tempDirectories: string[] = [];

const makeTempDirectory = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "mayo-metrics-store-"));
  tempDirectories.push(directory);
  return directory;
};

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const sampleMetrics = (): MetricsState => ({
  roomsCreated: 11,
  roomsReaped: 7,
  passwordFailures: 5,
  tokenFailures: 4,
  roomsLocked: 2,
  malformed: 3,
  rateLimited: { create: 6, join: 8, message: 9 },
  connections: { direct: 10, relay: 12 },
  connectionFailures: { ice: 13, connection: 14 },
});

interface MemoryFileSystem extends MetricsStoreFileSystem {
  files: Map<string, string>;
  writtenPaths: string[];
  renamedPaths: Array<{ oldPath: string; newPath: string }>;
}

const createMemoryFileSystem = (): MemoryFileSystem => {
  const files = new Map<string, string>();
  const writtenPaths: string[] = [];
  const renamedPaths: Array<{ oldPath: string; newPath: string }> = [];
  return {
    files,
    writtenPaths,
    renamedPaths,
    readFileSync: (path) => {
      const contents = files.get(path);
      if (contents === undefined) {
        throw new Error(`missing file: ${path}`);
      }
      return contents;
    },
    writeFileSync: (path, data) => {
      writtenPaths.push(path);
      files.set(path, data);
    },
    renameSync: (oldPath, newPath) => {
      const contents = files.get(oldPath);
      if (contents === undefined) {
        throw new Error(`missing temporary file: ${oldPath}`);
      }
      renamedPaths.push({ oldPath, newPath });
      files.set(newPath, contents);
      files.delete(oldPath);
    },
    unlinkSync: (path) => {
      files.delete(path);
    },
  };
};

describe("metrics snapshot store", () => {
  it("round-trips every counter through injected fs with an atomic replacement", () => {
    const filePath = "state/metrics.json";
    const fileSystem = createMemoryFileSystem();
    const store = createMetricsStore(filePath, { fileSystem });
    const metrics = sampleMetrics();

    store.flush(metrics);

    expect(fileSystem.writtenPaths).toHaveLength(1);
    expect(fileSystem.writtenPaths[0]).not.toBe(filePath);
    expect(fileSystem.renamedPaths).toHaveLength(1);
    expect(fileSystem.renamedPaths[0]?.newPath).toBe(filePath);
    expect(store.load()).toEqual(metrics);
  });

  it("does not restore live gauges or write them to the snapshot", () => {
    const filePath = "state/metrics.json";
    const fileSystem = createMemoryFileSystem();
    const store = createMetricsStore(filePath, { fileSystem });
    const metrics = {
      ...sampleMetrics(),
      roomsActive: 3,
      peersConnected: 4,
      transfersActive: 1,
    };

    store.flush(metrics);

    const serialized = fileSystem.files.get(filePath);
    expect(serialized).toBeDefined();
    expect(serialized).not.toContain("roomsActive");
    expect(serialized).not.toContain("peersConnected");
    expect(serialized).not.toContain("transfersActive");
    expect(store.load()).toEqual(sampleMetrics());
  });

  it.each([
    ["absent", undefined],
    ["malformed JSON", "{broken"],
    ["corrupt snapshot", JSON.stringify({ version: 1, counters: null })],
    [
      "invalid counter",
      JSON.stringify({
        version: 1,
        counters: { ...sampleMetrics(), malformed: -1 },
      }),
    ],
  ])(
    "loads zeroes without throwing for a %s state file",
    (_label, contents) => {
      const filePath = "state/metrics.json";
      const fileSystem = createMemoryFileSystem();
      if (contents !== undefined) {
        fileSystem.files.set(filePath, contents);
      }
      const log = vi.fn();
      const store = createMetricsStore(filePath, { fileSystem, log });

      expect(() => store.load()).not.toThrow();
      expect(store.load()).toEqual(createMetricsState());
      expect(log).toHaveBeenCalled();
    },
  );

  it("swallows injected write failures", () => {
    const log = vi.fn();
    const store = createMetricsStore("state/metrics.json", {
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

    expect(() => store.flush(sampleMetrics())).not.toThrow();
    expect(log).toHaveBeenCalledWith(
      "[metrics-store] could not save snapshot state/metrics.json: simulated write failure",
    );
  });

  it("restores configured counters into the server and flushes on close", async () => {
    const directory = makeTempDirectory();
    const filePath = join(directory, "metrics.json");
    const metrics = sampleMetrics();
    createMetricsStore(filePath).flush(metrics);
    vi.stubEnv("METRICS_STATE_PATH", filePath);
    vi.stubEnv("METRICS_TOKEN", "metrics-secret");

    const server = createServer({ webRoot: join(directory, "web") });
    try {
      const response = await server.app.inject({
        method: "GET",
        url: "/metrics",
        headers: { authorization: "Bearer metrics-secret" },
      });
      expect(response.body).toContain("mayo_rooms_created_total 11");
      expect(response.body).toContain(
        'mayo_connection_failures_total{phase="ice"} 13',
      );
    } finally {
      await server.close();
    }

    expect(readFileSync(filePath, "utf8")).toContain('"roomsCreated":11');
  });

  it("does not construct a metrics store when METRICS_STATE_PATH is unset", async () => {
    vi.resetModules();
    vi.stubEnv("METRICS_STATE_PATH", undefined);
    vi.stubEnv("ROOM_STATE_PATH", undefined);
    const createMetricsStoreMock = vi.fn(() => {
      throw new Error("metrics store should not be constructed");
    });
    vi.doMock("../src/metricsStore.js", async (importOriginal) => {
      const actual =
        await importOriginal<typeof import("../src/metricsStore.js")>();
      return { ...actual, createMetricsStore: createMetricsStoreMock };
    });

    try {
      const { createServer: createUnconfiguredServer } = await import(
        "../src/index.js"
      );
      const server = createUnconfiguredServer({
        webRoot: "/path-that-does-not-exist",
      });
      await server.close();
    } finally {
      vi.doUnmock("../src/metricsStore.js");
      vi.resetModules();
    }

    expect(createMetricsStoreMock).not.toHaveBeenCalled();
  });
});
