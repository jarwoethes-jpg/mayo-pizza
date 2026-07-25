import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import argon2 from "argon2";
import Fastify, { type FastifyInstance } from "fastify";
import { type SignalingMessage, signalingMessageSchema } from "shared";
import WebSocket, { WebSocketServer } from "ws";
import {
  createRateLimiter,
  getClientIp,
  parseTrustedProxyList,
  type RateLimiter,
} from "./ratelimit.js";
import { createRoomRegistry, type Room, type RoomRegistry } from "./rooms.js";
import { createIceServers, createTurnConfig, type TurnConfig } from "./turn.js";

const MAX_ROOM_PEERS = 2;

type ClientMessage = Extract<
  SignalingMessage,
  { t: "create" | "join" | "signal" | "ice-config" | "close" }
>;

interface PeerSession {
  id: string;
  socket: WebSocket;
  ip: string;
  roomSlug?: string;
}

export interface ServerOptions {
  roomRegistry?: RoomRegistry;
  rateLimiter?: RateLimiter;
  turnConfig?: TurnConfig;
  trustedProxies?: readonly string[];
  webRoot?: string;
  host?: string;
}

export interface ServerHandle {
  app: FastifyInstance;
  wsServer: WebSocketServer;
  listen: (port?: number) => Promise<number>;
  close: () => Promise<void>;
}

const sendMessage = (socket: WebSocket, message: SignalingMessage): void => {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
};

const sendError = (
  socket: WebSocket,
  code:
    | "BAD_SLUG"
    | "BAD_PASSWORD"
    | "RATE_LIMITED"
    | "ROOM_FULL"
    | "MALFORMED",
  message: string,
): void => {
  sendMessage(socket, { t: "error", code, message });
};

const getRoomForSession = (
  session: PeerSession,
  rooms: RoomRegistry,
): Room | undefined =>
  session.roomSlug === undefined ? undefined : rooms.getRoom(session.roomSlug);

const isClientMessage = (
  message: SignalingMessage,
): message is ClientMessage => {
  if (message.t === "signal") {
    return "to" in message;
  }
  if (message.t === "ice-config") {
    return !("iceServers" in message);
  }
  return (
    message.t === "create" || message.t === "join" || message.t === "close"
  );
};

const leaveSession = (session: PeerSession, rooms: RoomRegistry): void => {
  const room = getRoomForSession(session, rooms);
  delete session.roomSlug;
  if (room === undefined || !room.peers.has(session.id)) {
    return;
  }

  rooms.removePeer(room, session.id);
  for (const peer of room.peers.values()) {
    sendMessage(peer, { t: "peer-left", peerId: session.id });
  }
};

const handleMessage = async (
  session: PeerSession,
  rawData: WebSocket.RawData,
  rooms: RoomRegistry,
  rateLimiter: RateLimiter,
  turnConfig: TurnConfig,
): Promise<void> => {
  const messageLimit = rateLimiter.consume(session.ip, "message");
  if (!messageLimit.allowed) {
    sendError(
      session.socket,
      "RATE_LIMITED",
      "Too many messages. Please try again shortly.",
    );
    return;
  }

  let candidate: unknown;
  try {
    candidate = JSON.parse(rawData.toString()) as unknown;
  } catch {
    sendError(session.socket, "MALFORMED", "That message was not valid JSON.");
    session.socket.close(1008, "Malformed frame");
    return;
  }

  const parsed = signalingMessageSchema.safeParse(candidate);
  if (!parsed.success || !isClientMessage(parsed.data)) {
    sendError(
      session.socket,
      "MALFORMED",
      "That signaling message is not valid.",
    );
    session.socket.close(1008, "Malformed frame");
    return;
  }

  const message = parsed.data;
  if (message.t === "create") {
    if (!rateLimiter.consume(session.ip, "create").allowed) {
      sendError(
        session.socket,
        "RATE_LIMITED",
        "Too many room creations. Please try again later.",
      );
      return;
    }
    if (session.roomSlug !== undefined) {
      sendError(
        session.socket,
        "MALFORMED",
        "This socket already belongs to a room.",
      );
      return;
    }

    const passwordHash =
      message.password === undefined
        ? undefined
        : await argon2.hash(message.password, { type: argon2.argon2id });
    const room = rooms.createRoom(session.id, passwordHash);
    rooms.addPeer(room, session.id, session.socket);
    session.roomSlug = room.slug;
    sendMessage(session.socket, {
      t: "created",
      slug: room.slug,
      uploaderToken: randomBytes(32).toString("hex"),
    });
    return;
  }

  if (message.t === "join") {
    if (!rateLimiter.consume(session.ip, "join").allowed) {
      sendError(
        session.socket,
        "RATE_LIMITED",
        "Too many joins. Please try again later.",
      );
      return;
    }
    if (session.roomSlug !== undefined) {
      sendError(
        session.socket,
        "MALFORMED",
        "This socket already belongs to a room.",
      );
      return;
    }

    const room = rooms.getRoom(message.slug);
    if (room === undefined) {
      sendError(session.socket, "BAD_SLUG", "That room is not available.");
      return;
    }
    if (room.peers.size >= MAX_ROOM_PEERS) {
      sendError(session.socket, "ROOM_FULL", "That room is already full.");
      return;
    }
    if (room.passwordHash !== undefined) {
      const valid = await argon2.verify(
        room.passwordHash,
        message.password ?? "",
      );
      if (!valid) {
        sendError(
          session.socket,
          "BAD_PASSWORD",
          "That password does not match.",
        );
        return;
      }
    }

    rooms.addPeer(room, session.id, session.socket);
    session.roomSlug = room.slug;
    sendMessage(session.socket, {
      t: "joined",
      peerId: session.id,
      role: "downloader",
    });
    const uploader = room.peers.get(room.uploaderId);
    if (uploader !== undefined) {
      sendMessage(uploader, { t: "peer-joined", peerId: session.id });
    }
    return;
  }

  if (message.t === "signal") {
    if (!("to" in message)) {
      sendError(
        session.socket,
        "MALFORMED",
        "That signaling message is not valid.",
      );
      session.socket.close(1008, "Malformed frame");
      return;
    }
    const room = getRoomForSession(session, rooms);
    const target = room?.peers.get(message.to);
    if (room === undefined || target === undefined) {
      sendError(session.socket, "BAD_SLUG", "That peer is not available.");
      return;
    }
    rooms.touchRoom(room);
    sendMessage(target, {
      t: "signal",
      from: session.id,
      payload: message.payload,
    });
    return;
  }

  if (message.t === "ice-config") {
    sendMessage(session.socket, {
      t: "ice-config",
      iceServers: createIceServers(session.id, turnConfig),
    });
    const room = getRoomForSession(session, rooms);
    if (room !== undefined) {
      rooms.touchRoom(room);
    }
    return;
  }

  leaveSession(session, rooms);
  session.socket.close(1000, "Closed by client");
};

const attachWebSocketConnection = (
  socket: WebSocket,
  request: IncomingMessage,
  rooms: RoomRegistry,
  rateLimiter: RateLimiter,
  turnConfig: TurnConfig,
  trustedProxies: readonly string[],
): void => {
  const session: PeerSession = {
    id: randomUUID(),
    socket,
    ip: getClientIp(
      request.socket.remoteAddress,
      request.headers["x-forwarded-for"],
      trustedProxies,
    ),
  };

  socket.on("message", (rawData) => {
    void handleMessage(session, rawData, rooms, rateLimiter, turnConfig).catch(
      () => {
        sendError(
          session.socket,
          "MALFORMED",
          "The server could not process that message.",
        );
        session.socket.close(1011, "Message processing failed");
      },
    );
  });
  socket.once("close", () => leaveSession(session, rooms));
};

/** Creates the Phase 1 HTTP and WebSocket signaling server. */
export const createServer = (options: ServerOptions = {}): ServerHandle => {
  const app = Fastify({ logger: false });
  const rooms = options.roomRegistry ?? createRoomRegistry();
  const rateLimiter = options.rateLimiter ?? createRateLimiter();
  const turnConfig = options.turnConfig ?? createTurnConfig();
  const trustedProxies = options.trustedProxies ?? parseTrustedProxyList();
  const host = options.host ?? process.env.HOST ?? "0.0.0.0";
  const wsServer = new WebSocketServer({ noServer: true });
  const sessions = new Set<WebSocket>();
  const webRoot =
    options.webRoot ??
    process.env.WEB_ROOT ??
    fileURLToPath(new URL("../../web/dist/", import.meta.url));

  app.get("/healthz", async () => ({ ok: true }));
  if (existsSync(`${webRoot}/index.html`)) {
    app.register(fastifyStatic, { root: webRoot });
  }

  const upgradeHandler = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): void => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname !== "/ws") {
      socket.destroy();
      return;
    }

    wsServer.handleUpgrade(request, socket, head, (client) => {
      sessions.add(client);
      wsServer.emit("connection", client, request);
    });
  };

  app.server.on("upgrade", upgradeHandler);
  wsServer.on("connection", (socket, request) => {
    socket.once("close", () => sessions.delete(socket));
    attachWebSocketConnection(
      socket,
      request,
      rooms,
      rateLimiter,
      turnConfig,
      trustedProxies,
    );
  });

  app.addHook("onClose", async () => {
    app.server.off("upgrade", upgradeHandler);
    for (const socket of sessions) {
      socket.close(1001, "Server shutting down");
    }
    wsServer.close();
    rooms.dispose();
  });

  return {
    app,
    wsServer,
    listen: async (port = 3000) => {
      const address = await app.listen({ host, port });
      return Number(new URL(address).port);
    },
    close: async () => {
      await app.close();
    },
  };
};

/** Creates only the Fastify application for HTTP-focused tests. */
export const createApp = (options: ServerOptions = {}): FastifyInstance =>
  createServer(options).app;

/** Starts the signaling server on the requested port. */
export const startServer = async (port = 3000): Promise<ServerHandle> => {
  const server = createServer();
  await server.listen(port);
  return server;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  await startServer(port);
}
