import { Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createServer, type ServerHandle } from "../src/index.js";
import { createRoomRegistry, type RoomRegistry } from "../src/rooms.js";

type JsonMessage = Record<string, unknown>;

const openSocket = (url: string): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });

const nextMessage = (
  socket: WebSocket,
  timeoutMs = 2_000,
): Promise<JsonMessage> =>
  new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onMessage = (data: WebSocket.RawData): void => {
      cleanup();
      try {
        resolve(JSON.parse(data.toString()) as JsonMessage);
      } catch (error) {
        reject(error);
      }
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error("WebSocket closed before the expected message."));
    };
    socket.once("message", onMessage);
    socket.once("error", onError);
    socket.once("close", onClose);
    timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for a WebSocket message."));
    }, timeoutMs);
  });

const nextClose = (
  socket: WebSocket,
  timeoutMs = 2_000,
): Promise<{ code: number; reason: string }> =>
  new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off("close", onClose);
      socket.off("error", onError);
    };
    const onClose = (code: number, reason: Buffer): void => {
      cleanup();
      resolve({ code, reason: reason.toString() });
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    socket.once("close", onClose);
    socket.once("error", onError);
    timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for the WebSocket to close."));
    }, timeoutMs);
  });

const waitFor = async <T>(
  read: () => T | undefined,
  description: string,
  timeoutMs = 2_000,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const value = read();
    if (value !== undefined) {
      return value;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}.`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
};

describe("live room reaper", () => {
  let server: ServerHandle | undefined;
  let registry: RoomRegistry | undefined;
  let port: number | undefined;
  let reapedRoomCount: number | undefined;
  const logs: string[] = [];

  beforeAll(async () => {
    vi.stubEnv("LOG_LEVEL", "info");
    vi.stubEnv("METRICS_TOKEN", "metrics-secret");
    const logStream = new Writable({
      write(chunk, _encoding, callback) {
        logs.push(chunk.toString());
        callback();
      },
    });
    registry = createRoomRegistry({
      ttlMs: 100,
      intervalMs: 20,
      onRoomReaped: (_room, roomCount) => {
        reapedRoomCount = roomCount;
      },
    });
    server = createServer({
      roomRegistry: registry,
      host: "127.0.0.1",
      logStream,
    });
    port = await server.listen(0);
  });

  afterAll(async () => {
    try {
      await server?.close();
    } finally {
      registry?.dispose();
      vi.unstubAllEnvs();
    }
  });

  it("reaps an idle room on a running server", async () => {
    if (server === undefined || registry === undefined || port === undefined) {
      throw new Error("The live reaper server did not start.");
    }

    const socket = await openSocket(`ws://127.0.0.1:${port}/ws`);
    try {
      const createdPromise = nextMessage(socket);
      socket.send(JSON.stringify({ t: "create" }));
      const created = await createdPromise;
      expect(created).toEqual({
        t: "created",
        slug: expect.any(String),
        uploaderToken: expect.any(String),
      });
      const slug = created.slug;
      if (typeof slug !== "string") {
        throw new Error("The create handshake did not return a room slug.");
      }

      const [expired, closed, observedRoomCount] = await Promise.all([
        nextMessage(socket),
        nextClose(socket),
        waitFor(() => reapedRoomCount, "the live room reaper"),
      ]);

      expect(registry.rooms.size).toBe(0);
      expect(registry.getRoom(slug)).toBeUndefined();
      expect(expired).toEqual({
        t: "error",
        code: "BAD_SLUG",
        message: "That room has expired.",
      });
      expect(closed).toEqual({ code: 1001, reason: "Room expired" });
      expect(observedRoomCount).toBe(0);

      const metrics = await fetch(`http://127.0.0.1:${port}/metrics`, {
        headers: { authorization: "Bearer metrics-secret" },
      });
      expect(metrics.status).toBe(200);
      expect(await metrics.text()).toContain("mayo_rooms_reaped_total 1");

      const roomReapedLog = await waitFor(
        () =>
          logs
            .flatMap((chunk) => chunk.trim().split("\n"))
            .filter((line) => line.length > 0)
            .map((line) => JSON.parse(line) as JsonMessage)
            .find((line) => line.event === "room_reaped"),
        "the room_reaped log event",
      );
      expect(roomReapedLog).toMatchObject({
        event: "room_reaped",
        roomCount: 0,
      });
    } finally {
      socket.close();
    }
  });
});
