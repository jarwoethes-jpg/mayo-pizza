import { describe, expect, it } from "vitest";
import { createServer } from "../src/index.js";

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
    { socket: { remoteAddress: "127.0.0.1" }, headers: {} } as never,
  );
};

const stringField = (frame: Record<string, unknown>, field: string): string => {
  const value = frame[field];
  if (typeof value !== "string") {
    throw new Error(`Expected ${field} to be a string.`);
  }
  return value;
};

describe("password room behavior", () => {
  it("treats blank create passwords as no password", async () => {
    const server = createServer();

    try {
      for (const password of ["", "   "]) {
        const uploader = createFakeSocket();
        const downloader = createFakeSocket();
        connectFakeSocket(server, uploader);
        connectFakeSocket(server, downloader);

        uploader.emitMessage({ t: "create", password });
        const created = await waitForFrame(
          uploader,
          (frame) => frame.t === "created",
        );
        const joinedPromise = waitForFrame(
          downloader,
          (frame) => frame.t === "joined",
        );
        downloader.emitMessage({
          t: "join",
          slug: stringField(created, "slug"),
        });
        await expect(joinedPromise).resolves.toMatchObject({
          t: "joined",
          role: "downloader",
        });
        uploader.close();
        downloader.close();
      }
    } finally {
      await server.close();
    }
  });

  it("returns ROOM_LOCKED on the fifth wrong password", async () => {
    const server = createServer();
    const uploader = createFakeSocket();
    const downloader = createFakeSocket();
    connectFakeSocket(server, uploader);
    connectFakeSocket(server, downloader);

    try {
      uploader.emitMessage({ t: "create", password: "secret" });
      const created = await waitForFrame(
        uploader,
        (frame) => frame.t === "created",
      );
      const slug = stringField(created, "slug");

      for (let attempt = 0; attempt < 4; attempt += 1) {
        const errorPromise = waitForFrame(
          downloader,
          (frame) => frame.t === "error",
        );
        downloader.emitMessage({ t: "join", slug, password: "wrong" });
        await expect(errorPromise).resolves.toEqual({
          t: "error",
          code: "BAD_PASSWORD",
          message: "That password does not match.",
          attemptsRemaining: 4 - attempt,
        });
      }

      const lockedPromise = waitForFrame(
        downloader,
        (frame) => frame.t === "error",
      );
      downloader.emitMessage({ t: "join", slug, password: "wrong" });
      await expect(lockedPromise).resolves.toEqual({
        t: "error",
        code: "ROOM_LOCKED",
        message: "That room is locked after too many failed password attempts.",
      });
    } finally {
      uploader.close();
      downloader.close();
      await server.close();
    }
  });
});
