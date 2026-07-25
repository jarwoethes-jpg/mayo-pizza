import { createHmac } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
});
