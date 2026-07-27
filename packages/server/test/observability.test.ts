import type { IncomingMessage } from "node:http";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, createServer } from "../src/index.js";
import { createRoomRegistry } from "../src/rooms.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

interface FakeSocket {
  readyState: number;
  sent: string[];
  readCursor: number;
  on: (event: string, listener: (...args: unknown[]) => void) => FakeSocket;
  once: (event: string, listener: (...args: unknown[]) => void) => FakeSocket;
  send: (frame: string) => void;
  close: (code?: number, reason?: string) => void;
  emitMessage: (message: object) => void;
}

const createFakeSocket = (): FakeSocket => {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const socket: FakeSocket = {
    readyState: 1,
    sent: [],
    readCursor: 0,
    on: (event, listener) => {
      const eventListeners = listeners.get(event) ?? [];
      eventListeners.push(listener);
      listeners.set(event, eventListeners);
      return socket;
    },
    once: (event, listener) => {
      const wrapped = (...args: unknown[]): void => {
        const eventListeners = listeners.get(event) ?? [];
        listeners.set(
          event,
          eventListeners.filter((candidate) => candidate !== wrapped),
        );
        listener(...args);
      };
      return socket.on(event, wrapped);
    },
    send: (frame) => {
      socket.sent.push(frame);
    },
    close: (code = 1000, reason = "") => {
      socket.readyState = 3;
      for (const listener of [...(listeners.get("close") ?? [])]) {
        listener(code, reason);
      }
    },
    emitMessage: (message) => {
      for (const listener of [...(listeners.get("message") ?? [])]) {
        listener(Buffer.from(JSON.stringify(message)));
      }
    },
  };
  return socket;
};

const waitForFrame = async (
  socket: FakeSocket,
  predicate: (frame: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    while (socket.readCursor < socket.sent.length) {
      const frame = JSON.parse(
        socket.sent[socket.readCursor] ?? "null",
      ) as Record<string, unknown>;
      socket.readCursor += 1;
      if (predicate(frame)) {
        return frame;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for a fake WebSocket frame.");
};

const connectFakeSocket = (
  server: ReturnType<typeof createServer>,
  socket: FakeSocket,
): void => {
  server.wsServer.emit(
    "connection",
    socket as never,
    {
      socket: { remoteAddress: "127.0.0.1" },
      headers: {},
    } as IncomingMessage,
  );
};

const metricValue = (body: string, name: string): number => {
  const match = body.match(new RegExp(`^${name} (\\d+)$`, "m"));
  return match === null ? 0 : Number(match[1]);
};

describe("observability endpoints", () => {
  it("hides metrics without the bearer token and returns Prometheus text when authorized", async () => {
    vi.stubEnv("METRICS_TOKEN", "metrics-secret");
    const app = createApp();

    try {
      expect(
        (await app.inject({ method: "GET", url: "/metrics" })).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/metrics",
            headers: { authorization: "Bearer wrong" },
          })
        ).statusCode,
      ).toBe(404);

      const response = await app.inject({
        method: "GET",
        url: "/metrics",
        headers: { authorization: "Bearer metrics-secret" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain(
        "text/plain; version=0.0.4",
      );
      expect(response.body).toContain(
        "# HELP mayo_rooms_active Active signaling rooms.",
      );
      expect(response.body).toContain(
        "# TYPE mayo_rooms_created_total counter",
      );
      expect(response.body).toContain(
        'mayo_rate_limited_total{action="create"} 0',
      );
      expect(response.body).not.toContain("mayo_relay_bytes_total");
    } finally {
      await app.close();
    }
  });

  it("allows loopback-only metrics when no token is configured", async () => {
    vi.stubEnv("METRICS_TOKEN", "");
    const app = createApp();

    try {
      expect(
        (await app.inject({ method: "GET", url: "/metrics" })).statusCode,
      ).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("reports active rooms and transfers from the registry", async () => {
    vi.stubEnv("METRICS_TOKEN", "metrics-secret");
    const registry = createRoomRegistry({ startReaper: false });
    const room = registry.createRoom("uploader-1");
    registry.addPeer(room, "uploader-1", { readyState: 1 } as never);
    registry.addPeer(room, "downloader-1", { readyState: 1 } as never);
    const app = createApp({ roomRegistry: registry });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/metrics",
        headers: { authorization: "Bearer metrics-secret" },
      });
      expect(response.body).toContain("mayo_rooms_active 1");
      expect(response.body).toContain("mayo_transfers_active 1");
    } finally {
      await app.close();
    }
  });

  it("keeps token and password failure counters and events separate", async () => {
    vi.stubEnv("LOG_LEVEL", "info");
    vi.stubEnv("METRICS_TOKEN", "metrics-secret");
    const logs: string[] = [];
    const logStream = new Writable({
      write(chunk, _encoding, callback) {
        logs.push(chunk.toString());
        callback();
      },
    });
    const server = createServer({ logStream });
    const metrics = async (): Promise<string> => {
      const response = await server.app.inject({
        method: "GET",
        url: "/metrics",
        headers: { authorization: "Bearer metrics-secret" },
      });
      return response.body;
    };

    try {
      const uploader = createFakeSocket();
      const tokenDownloader = createFakeSocket();
      connectFakeSocket(server, uploader);
      connectFakeSocket(server, tokenDownloader);
      uploader.emitMessage({ t: "create", password: "secret" });
      const created = await waitForFrame(
        uploader,
        (frame) => frame.t === "created",
      );
      const slug = created.slug;
      if (typeof slug !== "string") {
        throw new Error("The fake create flow did not return a slug.");
      }
      const beforeToken = await metrics();

      for (let attempt = 0; attempt < 5; attempt += 1) {
        tokenDownloader.emitMessage({
          t: "join",
          slug,
          uploaderToken: `bad-token-${attempt}`,
        });
        await waitForFrame(
          tokenDownloader,
          (frame) => frame.t === "error" && frame.code === "BAD_PASSWORD",
        );
      }

      const afterToken = await metrics();
      expect(
        metricValue(afterToken, "mayo_token_failures_total") -
          metricValue(beforeToken, "mayo_token_failures_total"),
      ).toBe(5);
      expect(
        metricValue(afterToken, "mayo_password_failures_total") -
          metricValue(beforeToken, "mayo_password_failures_total"),
      ).toBe(0);
      expect(
        metricValue(afterToken, "mayo_rooms_locked_total") -
          metricValue(beforeToken, "mayo_rooms_locked_total"),
      ).toBe(0);

      tokenDownloader.emitMessage({ t: "join", slug, password: "secret" });
      await waitForFrame(
        tokenDownloader,
        (frame) => frame.t === "joined" && frame.role === "downloader",
      );
      const afterTokenPasswordJoin = await metrics();
      expect(afterTokenPasswordJoin).toContain(
        `mayo_token_failures_total ${metricValue(afterToken, "mayo_token_failures_total")}`,
      );

      const passwordUploader = createFakeSocket();
      const passwordDownloader = createFakeSocket();
      connectFakeSocket(server, passwordUploader);
      connectFakeSocket(server, passwordDownloader);
      passwordUploader.emitMessage({ t: "create", password: "secret" });
      const passwordCreated = await waitForFrame(
        passwordUploader,
        (frame) => frame.t === "created",
      );
      if (typeof passwordCreated.slug !== "string") {
        throw new Error("The fake password flow did not return a slug.");
      }
      const beforePassword = await metrics();
      for (let attempt = 0; attempt < 5; attempt += 1) {
        passwordDownloader.emitMessage({
          t: "join",
          slug: passwordCreated.slug,
          password: "wrong",
        });
        await waitForFrame(
          passwordDownloader,
          (frame) => frame.t === "error" && frame.code === "BAD_PASSWORD",
        );
      }
      const afterPassword = await metrics();
      expect(
        metricValue(afterPassword, "mayo_password_failures_total") -
          metricValue(beforePassword, "mayo_password_failures_total"),
      ).toBe(5);
      expect(
        metricValue(afterPassword, "mayo_token_failures_total") -
          metricValue(beforePassword, "mayo_token_failures_total"),
      ).toBe(0);
      expect(
        metricValue(afterPassword, "mayo_rooms_locked_total") -
          metricValue(beforePassword, "mayo_rooms_locked_total"),
      ).toBe(1);

      passwordDownloader.emitMessage({
        t: "join",
        slug: passwordCreated.slug,
        password: "secret",
      });
      await waitForFrame(
        passwordDownloader,
        (frame) => frame.t === "error" && frame.code === "ROOM_LOCKED",
      );
      const afterLockedRejection = await metrics();
      expect(afterLockedRejection).toContain(
        `mayo_password_failures_total ${metricValue(afterPassword, "mayo_password_failures_total")}`,
      );

      const events = logs
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .map((line) => line.event);
      expect(events.filter((event) => event === "token_failed")).toHaveLength(
        5,
      );
      expect(
        events.filter((event) => event === "password_failed"),
      ).toHaveLength(5);
      expect(events.filter((event) => event === "room_locked")).toHaveLength(1);
      expect(
        events.filter((event) => event === "room_locked_rejected"),
      ).toHaveLength(1);
      const roomLockedLog = logs
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((line) => line.event === "room_locked");
      expect(roomLockedLog?.code).toBe("ROOM_LOCKED");
      const roomLockedRejectedLog = logs
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find((line) => line.event === "room_locked_rejected");
      expect(roomLockedRejectedLog?.code).toBe("ROOM_LOCKED");
    } finally {
      await server.close();
    }
  });
});
