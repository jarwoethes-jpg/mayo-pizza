import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createServer, type ServerHandle } from "../src/index.js";
import { createRoomRegistry, type RoomRegistry } from "../src/rooms.js";
import { createTurnConfig } from "../src/turn.js";

type JsonMessage = Record<string, unknown>;

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

const stringField = (message: JsonMessage, field: string): string => {
  const value = message[field];
  if (typeof value !== "string") {
    throw new Error(`Expected ${field} to be a string.`);
  }
  return value;
};

describe("room persistence through a server restart", () => {
  const temporaryDirectories: string[] = [];
  const servers: ServerHandle[] = [];
  const registries: RoomRegistry[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await server.close();
    }
    for (const registry of registries.splice(0)) {
      registry.dispose();
    }
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("restores a created room so the original uploader token rejoins as uploader", async ({
    skip,
  }) => {
    const directory = mkdtempSync(join(tmpdir(), "mayo-room-restart-"));
    temporaryDirectories.push(directory);
    const statePath = join(directory, "rooms.json");
    const firstRegistry = createRoomRegistry({
      startReaper: false,
      statePath,
    });
    registries.push(firstRegistry);
    const firstServer = createServer({
      host: "127.0.0.1",
      roomRegistry: firstRegistry,
      turnConfig: createTurnConfig({
        TURN_STATIC_SECRET: "integration-secret",
      }),
    });
    servers.push(firstServer);
    let firstPort: number;
    try {
      firstPort = await firstServer.listen(0);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "EPERM"
      ) {
        skip();
        return;
      }
      throw error;
    }
    const uploader = await openSocket(`ws://127.0.0.1:${firstPort}/ws`);
    const createdPromise = nextMessage(uploader);
    uploader.send(JSON.stringify({ t: "create" }));
    const created = await createdPromise;
    const slug = stringField(created, "slug");
    const uploaderToken = stringField(created, "uploaderToken");
    firstRegistry.flush();
    uploader.close();
    await firstServer.close();
    servers.splice(servers.indexOf(firstServer), 1);

    const restoredRegistry = createRoomRegistry({
      startReaper: false,
      statePath,
    });
    registries.push(restoredRegistry);
    const restoredServer = createServer({
      host: "127.0.0.1",
      roomRegistry: restoredRegistry,
      turnConfig: createTurnConfig({
        TURN_STATIC_SECRET: "integration-secret",
      }),
    });
    servers.push(restoredServer);
    const restoredPort = await restoredServer.listen(0);
    const rejoinedUploader = await openSocket(
      `ws://127.0.0.1:${restoredPort}/ws`,
    );
    try {
      const joinedPromise = nextMessage(rejoinedUploader);
      rejoinedUploader.send(JSON.stringify({ t: "join", slug, uploaderToken }));
      expect(await joinedPromise).toMatchObject({
        t: "joined",
        role: "uploader",
      });
    } finally {
      rejoinedUploader.close();
    }
  });
});
