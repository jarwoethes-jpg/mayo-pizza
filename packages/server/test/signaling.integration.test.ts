import { createHmac } from "node:crypto";
import { existsSync } from "node:fs";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import argon2 from "argon2";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createServer, type ServerHandle } from "../src/index.js";
import { createTurnConfig } from "../src/turn.js";

type JsonMessage = Record<string, unknown>;
const staticIndex = fileURLToPath(
  new URL("../../web/dist/index.html", import.meta.url),
);

const openSocket = (url: string): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });

const nextMessage = (socket: WebSocket): Promise<JsonMessage> =>
  new Promise((resolve, reject) => {
    socket.once("message", (data) => {
      try {
        resolve(JSON.parse(data.toString()) as JsonMessage);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });

interface FrameQueue {
  next(): Promise<JsonMessage>;
  dispose(): void;
}

/** Keeps one ordered receive stream per socket when several frames are pending. */
const createFrameQueue = (socket: WebSocket): FrameQueue => {
  const frames: JsonMessage[] = [];
  const waiters: Array<{
    resolve: (message: JsonMessage) => void;
    reject: (error: Error) => void;
  }> = [];
  let terminalError: Error | undefined;

  const onMessage = (data: WebSocket.RawData): void => {
    try {
      const message = JSON.parse(data.toString()) as JsonMessage;
      const waiter = waiters.shift();
      if (waiter === undefined) {
        frames.push(message);
      } else {
        waiter.resolve(message);
      }
    } catch (error) {
      terminalError = error instanceof Error ? error : new Error(String(error));
      const pending = waiters.splice(0);
      for (const waiter of pending) {
        waiter.reject(terminalError);
      }
    }
  };
  const onError = (error: Error): void => {
    terminalError = error;
    const pending = waiters.splice(0);
    for (const waiter of pending) {
      waiter.reject(error);
    }
  };
  socket.on("message", onMessage);
  socket.on("error", onError);

  return {
    next: () => {
      const message = frames.shift();
      if (message !== undefined) {
        return Promise.resolve(message);
      }
      if (terminalError !== undefined) {
        return Promise.reject(terminalError);
      }
      return new Promise<JsonMessage>((resolve, reject) => {
        waiters.push({ resolve, reject });
      });
    },
    dispose: () => {
      socket.off("message", onMessage);
      socket.off("error", onError);
    },
  };
};

const nextClose = (socket: WebSocket): Promise<void> =>
  new Promise((resolve) => {
    socket.once("close", () => resolve());
  });

const stringField = (message: JsonMessage, field: string): string => {
  const value = message[field];
  if (typeof value !== "string") {
    throw new Error(`Expected ${field} to be a string.`);
  }
  return value;
};

describe("localhost signaling server", () => {
  let server: ServerHandle;
  let port: number;

  beforeAll(async () => {
    server = createServer({
      host: "127.0.0.1",
      turnConfig: createTurnConfig({
        TURN_STATIC_SECRET: "integration-secret",
      }),
    });
    port = await server.listen(0);
  });

  afterAll(async () => {
    await server.close();
  });

  it("completes create, join, relay, TURN, malformed-frame, and static checks", async () => {
    const url = `ws://127.0.0.1:${port}/ws`;
    const uploader = await openSocket(url);
    const downloader = await openSocket(url);

    try {
      const createdPromise = nextMessage(uploader);
      uploader.send(JSON.stringify({ t: "create" }));
      const created = await createdPromise;
      const slug = stringField(created, "slug");
      expect(created).toMatchObject({
        t: "created",
        uploaderToken: expect.any(String),
      });

      const joinedPromise = nextMessage(downloader);
      const peerJoinedPromise = nextMessage(uploader);
      downloader.send(JSON.stringify({ t: "join", slug }));
      const [joined, peerJoined] = await Promise.all([
        joinedPromise,
        peerJoinedPromise,
      ]);
      const downloaderPeerId = stringField(joined, "peerId");
      expect(joined).toEqual({
        t: "joined",
        peerId: downloaderPeerId,
        role: "downloader",
      });
      expect(peerJoined).toEqual({
        t: "peer-joined",
        peerId: downloaderPeerId,
      });

      const relayedPromise = nextMessage(downloader);
      uploader.send(
        JSON.stringify({
          t: "signal",
          to: downloaderPeerId,
          payload: { x: 1 },
        }),
      );
      expect(await relayedPromise).toEqual({
        t: "signal",
        from: expect.any(String),
        payload: { x: 1 },
      });

      downloader.send(
        JSON.stringify({ t: "stat", event: "connected", route: "direct" }),
      );
      const metricsInit: RequestInit = {};
      if (process.env.METRICS_TOKEN !== undefined) {
        metricsInit.headers = {
          authorization: `Bearer ${process.env.METRICS_TOKEN}`,
        };
      }
      const metrics = await fetch(
        `http://127.0.0.1:${port}/metrics`,
        metricsInit,
      );
      expect(metrics.status).toBe(200);
      const metricsBody = await metrics.text();
      expect(metricsBody).toContain("mayo_rooms_active 1");
      expect(metricsBody).toContain("mayo_peers_connected 2");
      expect(metricsBody).toContain("mayo_transfers_active 1");
      expect(metricsBody).toContain("mayo_rooms_created_total 1");
      expect(metricsBody).toContain('mayo_connections_total{route="direct"} 1');

      const iceConfigPromise = nextMessage(downloader);
      downloader.send(JSON.stringify({ t: "ice-config" }));
      const iceConfig = await iceConfigPromise;
      const iceServers = iceConfig.iceServers as Array<Record<string, unknown>>;
      const turnServer = iceServers[1];
      if (turnServer === undefined) {
        throw new Error("TURN server entry is missing.");
      }
      expect(iceConfig.t).toBe("ice-config");
      const username = stringField(turnServer, "username");
      const credential = stringField(turnServer, "credential");
      expect(credential).toBe(
        createHmac("sha1", "integration-secret")
          .update(username)
          .digest("base64"),
      );
      expect(username.endsWith(`:${downloaderPeerId}`)).toBe(true);

      const malformed = await openSocket(url);
      const malformedErrorPromise = nextMessage(malformed);
      const malformedClosePromise = nextClose(malformed);
      malformed.send(JSON.stringify({ t: "nope" }));
      expect(await malformedErrorPromise).toEqual({
        t: "error",
        code: "MALFORMED",
        message: expect.any(String),
      });
      await malformedClosePromise;
    } finally {
      uploader.close();
      downloader.close();
    }
  });

  it.skipIf(!existsSync(staticIndex))(
    "serves the built web index",
    async () => {
      const response = await fetch(`http://127.0.0.1:${port}/`);

      expect(response.status).toBe(200);
      expect(await response.text()).toContain("mayo.pizza");
    },
  );

  it("hashes room passwords and broadcasts peer departure", async () => {
    const url = `ws://127.0.0.1:${port}/ws`;
    const uploader = await openSocket(url);
    const wrongDownloader = await openSocket(url);
    const downloader = await openSocket(url);

    try {
      const createdPromise = nextMessage(uploader);
      uploader.send(JSON.stringify({ t: "create", password: "secret" }));
      const created = await createdPromise;
      const slug = stringField(created, "slug");

      const wrongPasswordPromise = nextMessage(wrongDownloader);
      wrongDownloader.send(
        JSON.stringify({ t: "join", slug, password: "wrong" }),
      );
      expect(await wrongPasswordPromise).toMatchObject({
        t: "error",
        code: "BAD_PASSWORD",
      });

      const joinedPromise = nextMessage(downloader);
      const peerJoinedPromise = nextMessage(uploader);
      downloader.send(JSON.stringify({ t: "join", slug, password: "secret" }));
      const joined = await joinedPromise;
      await peerJoinedPromise;
      const downloaderPeerId = stringField(joined, "peerId");

      const peerLeftPromise = nextMessage(uploader);
      const closePromise = nextClose(downloader);
      downloader.send(JSON.stringify({ t: "close" }));
      expect(await peerLeftPromise).toEqual({
        t: "peer-left",
        peerId: downloaderPeerId,
      });
      await closePromise;
    } finally {
      uploader.close();
      wrongDownloader.close();
      downloader.close();
    }
  });

  it("does not count a missing password as a failed attempt", async () => {
    const url = `ws://127.0.0.1:${port}/ws`;
    const uploader = await openSocket(url);
    const downloader = await openSocket(url);

    try {
      const createdPromise = nextMessage(uploader);
      uploader.send(JSON.stringify({ t: "create", password: "secret" }));
      const created = await createdPromise;
      const slug = stringField(created, "slug");

      const requiredPromise = nextMessage(downloader);
      downloader.send(JSON.stringify({ t: "join", slug }));
      expect(await requiredPromise).toEqual({
        t: "error",
        code: "PASSWORD_REQUIRED",
        message: expect.any(String),
      });

      for (let attempt = 0; attempt < 4; attempt += 1) {
        const errorPromise = nextMessage(downloader);
        downloader.send(JSON.stringify({ t: "join", slug, password: "wrong" }));
        expect(await errorPromise).toMatchObject({
          t: "error",
          code: "BAD_PASSWORD",
          attemptsRemaining: 4 - attempt,
        });
      }

      const joinedPromise = nextMessage(downloader);
      const peerJoinedPromise = nextMessage(uploader);
      downloader.send(JSON.stringify({ t: "join", slug, password: "secret" }));
      expect(await joinedPromise).toMatchObject({
        t: "joined",
        role: "downloader",
      });
      await peerJoinedPromise;
    } finally {
      uploader.close();
      downloader.close();
    }
  });

  it("does not lock a room after five empty-password probes", async () => {
    const url = `ws://127.0.0.1:${port}/ws`;
    const uploader = await openSocket(url);
    const downloader = await openSocket(url);
    const verify = vi.spyOn(argon2, "verify");

    try {
      const createdPromise = nextMessage(uploader);
      uploader.send(JSON.stringify({ t: "create", password: "secret" }));
      const created = await createdPromise;
      const slug = stringField(created, "slug");
      const verifiesBeforeProbes = verify.mock.calls.length;

      for (let probe = 0; probe < 5; probe += 1) {
        const requiredPromise = nextMessage(downloader);
        downloader.send(JSON.stringify({ t: "join", slug, password: "   " }));
        expect(await requiredPromise).toEqual({
          t: "error",
          code: "PASSWORD_REQUIRED",
          message: expect.any(String),
        });
      }
      expect(verify.mock.calls.length).toBe(verifiesBeforeProbes);

      for (let attempt = 0; attempt < 4; attempt += 1) {
        const errorPromise = nextMessage(downloader);
        downloader.send(JSON.stringify({ t: "join", slug, password: "wrong" }));
        expect(await errorPromise).toMatchObject({
          t: "error",
          code: "BAD_PASSWORD",
          attemptsRemaining: 4 - attempt,
        });
      }

      const joinedPromise = nextMessage(downloader);
      const peerJoinedPromise = nextMessage(uploader);
      downloader.send(JSON.stringify({ t: "join", slug, password: "secret" }));
      expect(await joinedPromise).toMatchObject({
        t: "joined",
        role: "downloader",
      });
      await peerJoinedPromise;
    } finally {
      verify.mockRestore();
      uploader.close();
      downloader.close();
    }
  });

  it("keeps a room after the uploader drops and symmetrically announces token rejoin", async () => {
    const url = `ws://127.0.0.1:${port}/ws`;
    const uploader = await openSocket(url);
    const downloader = await openSocket(url);
    let rejoinedUploader: WebSocket | undefined;
    let rejoinedFrames: FrameQueue | undefined;

    try {
      const createdPromise = nextMessage(uploader);
      uploader.send(JSON.stringify({ t: "create" }));
      const created = await createdPromise;
      const slug = stringField(created, "slug");
      const uploaderToken = stringField(created, "uploaderToken");

      const joinedPromise = nextMessage(downloader);
      const peerJoinedPromise = nextMessage(uploader);
      downloader.send(JSON.stringify({ t: "join", slug }));
      const joined = await joinedPromise;
      await peerJoinedPromise;
      const downloaderPeerId = stringField(joined, "peerId");

      const leftPromise = nextMessage(downloader);
      uploader.close();
      expect(await leftPromise).toEqual({
        t: "peer-left",
        peerId: expect.any(String),
      });

      rejoinedUploader = await openSocket(url);
      rejoinedFrames = createFrameQueue(rejoinedUploader);
      const rejoinedPromise = rejoinedFrames.next();
      const rejoinedPeerPromise = rejoinedFrames.next();
      const downloaderPeerAnnouncement = nextMessage(downloader);
      rejoinedUploader.send(JSON.stringify({ t: "join", slug, uploaderToken }));
      expect(await rejoinedPromise).toMatchObject({
        t: "joined",
        role: "uploader",
        peerId: expect.any(String),
      });
      const rejoinedPeer = await rejoinedPeerPromise;
      const downloaderAnnouncement = await downloaderPeerAnnouncement;
      expect(rejoinedPeer).toEqual({
        t: "peer-joined",
        peerId: downloaderPeerId,
      });
      expect(downloaderAnnouncement).toEqual({
        t: "peer-joined",
        peerId: expect.any(String),
      });
    } finally {
      uploader.close();
      downloader.close();
      rejoinedFrames?.dispose();
      rejoinedUploader?.close();
    }
  });

  it("locks password rooms after five failures without verifying after lockout", async () => {
    const url = `ws://127.0.0.1:${port}/ws`;
    const uploader = await openSocket(url);
    const downloader = await openSocket(url);
    const verify = vi.spyOn(argon2, "verify");

    try {
      const createdPromise = nextMessage(uploader);
      uploader.send(JSON.stringify({ t: "create", password: "secret" }));
      const created = await createdPromise;
      const slug = stringField(created, "slug");

      for (let attempt = 0; attempt < 4; attempt += 1) {
        const errorPromise = nextMessage(downloader);
        downloader.send(JSON.stringify({ t: "join", slug, password: "wrong" }));
        expect(await errorPromise).toMatchObject({
          t: "error",
          code: "BAD_PASSWORD",
          attemptsRemaining: 4 - attempt,
        });
      }

      const joinedPromise = nextMessage(downloader);
      const peerJoinedPromise = nextMessage(uploader);
      downloader.send(JSON.stringify({ t: "join", slug, password: "secret" }));
      expect(await joinedPromise).toMatchObject({
        t: "joined",
        role: "downloader",
      });
      await peerJoinedPromise;

      const lockedUploader = await openSocket(url);
      const lockedDownloader = await openSocket(url);
      try {
        const lockedCreatedPromise = nextMessage(lockedUploader);
        lockedUploader.send(
          JSON.stringify({ t: "create", password: "secret" }),
        );
        const lockedCreated = await lockedCreatedPromise;
        const lockedSlug = stringField(lockedCreated, "slug");

        for (let attempt = 0; attempt < 5; attempt += 1) {
          const errorPromise = nextMessage(lockedDownloader);
          lockedDownloader.send(
            JSON.stringify({ t: "join", slug: lockedSlug, password: "wrong" }),
          );
          if (attempt < 4) {
            expect(await errorPromise).toMatchObject({
              t: "error",
              code: "BAD_PASSWORD",
              attemptsRemaining: 4 - attempt,
            });
          } else {
            expect(await errorPromise).toEqual({
              t: "error",
              code: "ROOM_LOCKED",
              message:
                "That room is locked after too many failed password attempts.",
            });
          }
        }

        const verifiesBeforeLockedJoin = verify.mock.calls.length;
        const lockedErrorPromise = nextMessage(lockedDownloader);
        lockedDownloader.send(
          JSON.stringify({ t: "join", slug: lockedSlug, password: "secret" }),
        );
        expect(await lockedErrorPromise).toMatchObject({
          t: "error",
          code: "ROOM_LOCKED",
        });
        expect(verify.mock.calls.length).toBe(verifiesBeforeLockedJoin);
      } finally {
        lockedUploader.close();
        lockedDownloader.close();
      }
    } finally {
      verify.mockRestore();
      uploader.close();
      downloader.close();
    }
  });

  it("does not let five bad uploader tokens block a correct password join", async () => {
    const url = `ws://127.0.0.1:${port}/ws`;
    const uploader = await openSocket(url);
    const downloader = await openSocket(url);

    try {
      const createdPromise = nextMessage(uploader);
      uploader.send(JSON.stringify({ t: "create", password: "secret" }));
      const created = await createdPromise;
      const slug = stringField(created, "slug");

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const errorPromise = nextMessage(downloader);
        downloader.send(
          JSON.stringify({
            t: "join",
            slug,
            uploaderToken: `bogus-token-${attempt}`,
          }),
        );
        expect(await errorPromise).toMatchObject({
          t: "error",
          code: "BAD_PASSWORD",
        });
      }

      const joinedPromise = nextMessage(downloader);
      const peerJoinedPromise = nextMessage(uploader);
      downloader.send(JSON.stringify({ t: "join", slug, password: "secret" }));
      expect(await joinedPromise).toMatchObject({
        t: "joined",
        role: "downloader",
      });
      await peerJoinedPromise;
    } finally {
      uploader.close();
      downloader.close();
    }
  });

  it("keeps the uploader token usable after room lockout and caps token failures separately", async () => {
    const url = `ws://127.0.0.1:${port}/ws`;
    const uploader = await openSocket(url);
    const downloader = await openSocket(url);
    let rejoinedUploader: WebSocket | undefined;

    try {
      const createdPromise = nextMessage(uploader);
      uploader.send(JSON.stringify({ t: "create", password: "secret" }));
      const created = await createdPromise;
      const slug = stringField(created, "slug");
      const uploaderToken = stringField(created, "uploaderToken");

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const errorPromise = nextMessage(downloader);
        downloader.send(JSON.stringify({ t: "join", slug, password: "wrong" }));
        if (attempt < 4) {
          expect(await errorPromise).toMatchObject({
            t: "error",
            code: "BAD_PASSWORD",
            attemptsRemaining: 4 - attempt,
          });
        } else {
          expect(await errorPromise).toEqual({
            t: "error",
            code: "ROOM_LOCKED",
            message:
              "That room is locked after too many failed password attempts.",
          });
        }
      }

      const uploaderClose = nextClose(uploader);
      uploader.close();
      await uploaderClose;
      rejoinedUploader = await openSocket(url);
      const joinedPromise = nextMessage(rejoinedUploader);
      rejoinedUploader.send(JSON.stringify({ t: "join", slug, uploaderToken }));
      expect(await joinedPromise).toMatchObject({
        t: "joined",
        role: "uploader",
      });
    } finally {
      uploader.close();
      downloader.close();
      rejoinedUploader?.close();
    }
  });

  it("emits allowlisted JSON logs without room capabilities", async () => {
    vi.stubEnv("LOG_LEVEL", "info");
    const output: string[] = [];
    const logStream = new Writable({
      write(chunk, _encoding, callback) {
        output.push(chunk.toString());
        callback();
      },
    });
    const loggedServer = createServer({
      host: "127.0.0.1",
      logStream,
      turnConfig: createTurnConfig({
        TURN_STATIC_SECRET: "integration-secret",
      }),
    });
    const loggedPort = await loggedServer.listen(0);
    const url = `ws://127.0.0.1:${loggedPort}/ws`;
    const uploader = await openSocket(url);
    const downloader = await openSocket(url);
    let roomSlug = "";
    let uploaderToken = "";

    try {
      const createdPromise = nextMessage(uploader);
      uploader.send(JSON.stringify({ t: "create", password: "secret" }));
      const created = await createdPromise;
      roomSlug = stringField(created, "slug");
      uploaderToken = stringField(created, "uploaderToken");
      const joinedPromise = nextMessage(downloader);
      const peerJoinedPromise = nextMessage(uploader);
      downloader.send(
        JSON.stringify({ t: "join", slug: roomSlug, password: "secret" }),
      );
      const joined = await joinedPromise;
      const downloaderPeerId = stringField(joined, "peerId");
      await peerJoinedPromise;
      const signalPromise = nextMessage(downloader);
      uploader.send(
        JSON.stringify({
          t: "signal",
          to: downloaderPeerId,
          payload: { x: 1 },
        }),
      );
      await signalPromise;
      const downloaderClose = nextClose(downloader);
      downloader.send(JSON.stringify({ t: "close" }));
      await downloaderClose;
      const uploaderClose = nextClose(uploader);
      uploader.send(JSON.stringify({ t: "close" }));
      await uploaderClose;
    } finally {
      uploader.close();
      downloader.close();
      await loggedServer.close();
      vi.unstubAllEnvs();
    }

    const lines = output
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const allowedKeys = new Set([
      "ts",
      "level",
      "event",
      "peerId",
      "ip",
      "roomCount",
      "code",
    ]);
    expect(lines.length).toBeGreaterThan(0);
    const eventLines = lines.filter((line) => typeof line.event === "string");
    expect(eventLines.length).toBeGreaterThan(0);
    for (const line of eventLines) {
      expect(Object.keys(line).every((key) => allowedKeys.has(key))).toBe(true);
    }
    for (const line of lines) {
      if (typeof line.msg === "string") {
        expect(line.msg).not.toContain(roomSlug);
        expect(line.msg).not.toContain(uploaderToken);
      }
    }
    const events = new Set(eventLines.map((line) => line.event));
    expect([...events]).toEqual(
      expect.arrayContaining([
        "ws_open",
        "ws_close",
        "room_created",
        "room_joined",
        "room_left",
      ]),
    );
    const logText = JSON.stringify(lines);
    expect(logText).not.toContain(roomSlug);
    expect(logText).not.toContain(uploaderToken);
  });
});
