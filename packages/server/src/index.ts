import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import type { Duplex, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import argon2 from "argon2";
import Fastify, { type FastifyInstance, LogController } from "fastify";
import { type SignalingMessage, signalingMessageSchema } from "shared";
import WebSocket, { WebSocketServer } from "ws";
import {
  createRateLimiter,
  getClientIp,
  parseRateLimitOverrides,
  parseTrustedProxyList,
  type RateLimitAction,
  type RateLimiter,
} from "./ratelimit.js";
import {
  createRoomRegistry,
  hashUploaderToken,
  parseRoomTtlEnv,
  ROOM_AUTH_FAILURE_LIMIT,
  ROOM_TTL_MS,
  type Room,
  type RoomRegistry,
} from "./rooms.js";
import { createIceServers, createTurnConfig, type TurnConfig } from "./turn.js";

const MAX_ROOM_PEERS = 2;

/**
 * Explicit Argon2id settings at the OWASP-recommended argon2id minimum.
 *
 * WHY: the room password is on a capability URL that expires after 30 idle
 * minutes, behind a five-attempt sticky room lockout and 60 joins/hour/IP
 * limit, so online guessing is the threat model. Cheap verification is also
 * hardening because Argon2 shares libuv's threadpool with static file serving.
 */
export const ARGON2_OPTIONS = Object.freeze({
  type: argon2.argon2id,
  memoryCost: 19 * 1024,
  timeCost: 2,
  parallelism: 1,
});

type ClientMessage = Extract<
  SignalingMessage,
  { t: "create" | "join" | "signal" | "ice-config" | "close" | "stat" }
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
  logStream?: Writable;
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
  code: Extract<SignalingMessage, { t: "error" }>["code"],
  message: string,
  attemptsRemaining?: number,
): void => {
  sendMessage(socket, {
    t: "error",
    code,
    message,
    ...(attemptsRemaining === undefined ? {} : { attemptsRemaining }),
  });
};

type LogFields = {
  peerId?: string;
  ip?: string;
  roomCount?: number;
  code?: string;
};

type EmitLog = (event: string, fields?: LogFields) => void;

interface MetricsState {
  roomsCreated: number;
  roomsReaped: number;
  passwordFailures: number;
  tokenFailures: number;
  roomsLocked: number;
  malformed: number;
  rateLimited: Record<RateLimitAction, number>;
  connections: Record<"direct" | "relay", number>;
}

const createMetricsState = (): MetricsState => ({
  roomsCreated: 0,
  roomsReaped: 0,
  passwordFailures: 0,
  tokenFailures: 0,
  roomsLocked: 0,
  malformed: 0,
  rateLimited: { create: 0, join: 0, message: 0 },
  connections: { direct: 0, relay: 0 },
});

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
    message.t === "create" ||
    message.t === "join" ||
    message.t === "close" ||
    message.t === "stat"
  );
};

const leaveSession = (
  session: PeerSession,
  rooms: RoomRegistry,
  emitLog: EmitLog,
): void => {
  const room = getRoomForSession(session, rooms);
  delete session.roomSlug;
  if (room === undefined || !room.peers.has(session.id)) {
    return;
  }

  rooms.removePeer(room, session.id);
  for (const peer of room.peers.values()) {
    sendMessage(peer, { t: "peer-left", peerId: session.id });
  }
  emitLog("room_left", {
    peerId: session.id,
    ip: session.ip,
    roomCount: rooms.rooms.size,
  });
};

const logAuthFailure = (
  session: PeerSession,
  rooms: RoomRegistry,
  metrics: MetricsState,
  emitLog: EmitLog,
  event: "password_failed" | "token_failed",
  locked: boolean,
): void => {
  emitLog(event, {
    peerId: session.id,
    ip: session.ip,
    code: "BAD_PASSWORD",
    roomCount: rooms.rooms.size,
  });
  if (locked) {
    metrics.roomsLocked += 1;
    emitLog("room_locked", {
      peerId: session.id,
      ip: session.ip,
      code: "ROOM_LOCKED",
      roomCount: rooms.rooms.size,
    });
  }
};

const handleMessage = async (
  session: PeerSession,
  rawData: WebSocket.RawData,
  rooms: RoomRegistry,
  rateLimiter: RateLimiter,
  turnConfig: TurnConfig,
  metrics: MetricsState,
  emitLog: EmitLog,
): Promise<void> => {
  const messageLimit = rateLimiter.consume(session.ip, "message");
  if (!messageLimit.allowed) {
    metrics.rateLimited.message += 1;
    emitLog("rate_limited", {
      peerId: session.id,
      ip: session.ip,
      code: "RATE_LIMITED",
      roomCount: rooms.rooms.size,
    });
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
    metrics.malformed += 1;
    emitLog("malformed", {
      peerId: session.id,
      ip: session.ip,
      code: "MALFORMED",
      roomCount: rooms.rooms.size,
    });
    sendError(session.socket, "MALFORMED", "That message was not valid JSON.");
    session.socket.close(1008, "Malformed frame");
    return;
  }

  const parsed = signalingMessageSchema.safeParse(candidate);
  if (!parsed.success || !isClientMessage(parsed.data)) {
    metrics.malformed += 1;
    emitLog("malformed", {
      peerId: session.id,
      ip: session.ip,
      code: "MALFORMED",
      roomCount: rooms.rooms.size,
    });
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
      metrics.rateLimited.create += 1;
      emitLog("rate_limited", {
        peerId: session.id,
        ip: session.ip,
        code: "RATE_LIMITED",
        roomCount: rooms.rooms.size,
      });
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

    // WHY: mirror the join-side blank check; hashing a blank password would make the room unjoinable.
    const passwordHash =
      message.password === undefined || message.password.trim() === ""
        ? undefined
        : await argon2.hash(message.password, ARGON2_OPTIONS);
    const uploaderToken = randomBytes(32).toString("hex");
    const room = rooms.createRoom(session.id, passwordHash, uploaderToken);
    rooms.addPeer(room, session.id, session.socket);
    session.roomSlug = room.slug;
    metrics.roomsCreated += 1;
    emitLog("room_created", {
      peerId: session.id,
      ip: session.ip,
      roomCount: rooms.rooms.size,
    });
    sendMessage(session.socket, {
      t: "created",
      slug: room.slug,
      uploaderToken,
    });
    return;
  }

  if (message.t === "join") {
    if (!rateLimiter.consume(session.ip, "join").allowed) {
      metrics.rateLimited.join += 1;
      emitLog("rate_limited", {
        peerId: session.id,
        ip: session.ip,
        code: "RATE_LIMITED",
        roomCount: rooms.rooms.size,
      });
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
    const suppliedToken = message.uploaderToken;
    const isUploaderRejoin = suppliedToken !== undefined;
    if (isUploaderRejoin) {
      const expected = room.uploaderTokenHash;
      const supplied = Buffer.from(hashUploaderToken(suppliedToken));
      const expectedBuffer =
        expected === undefined ? undefined : Buffer.from(expected);
      if (
        expectedBuffer === undefined ||
        supplied.length !== expectedBuffer.length ||
        !timingSafeEqual(supplied, expectedBuffer)
      ) {
        rooms.recordTokenFailure(room);
        metrics.tokenFailures += 1;
        logAuthFailure(session, rooms, metrics, emitLog, "token_failed", false);
        sendError(
          session.socket,
          "BAD_PASSWORD",
          "That uploader token does not match.",
        );
        return;
      }
      rooms.resetTokenFailures(room);
      const staleUploaderId = room.uploaderId;
      if (staleUploaderId !== session.id) {
        const staleUploader = room.peers.get(staleUploaderId);
        if (staleUploader !== undefined) {
          room.peers.delete(staleUploaderId);
          staleUploader.close(1000, "Uploader rejoined");
          for (const peer of room.peers.values()) {
            sendMessage(peer, { t: "peer-left", peerId: staleUploaderId });
          }
        }
      }
    } else if (room.lockedAt !== undefined) {
      emitLog("room_locked_rejected", {
        peerId: session.id,
        ip: session.ip,
        code: "ROOM_LOCKED",
        roomCount: rooms.rooms.size,
      });
      sendError(
        session.socket,
        "ROOM_LOCKED",
        "That room is locked after too many failed password attempts.",
      );
      return;
    } else if (room.peers.size >= MAX_ROOM_PEERS) {
      sendError(session.socket, "ROOM_FULL", "That room is already full.");
      return;
    }
    if (!isUploaderRejoin && room.passwordHash !== undefined) {
      if (message.password === undefined || message.password.trim() === "") {
        // WHY: probing whether a room is protected must be free, or page loads alone would lock the room.
        sendError(
          session.socket,
          "PASSWORD_REQUIRED",
          "That room requires a password.",
        );
        return;
      }
      const valid = await argon2.verify(room.passwordHash, message.password);
      if (!valid) {
        metrics.passwordFailures += 1;
        const locked = rooms.recordPasswordFailure(room);
        logAuthFailure(
          session,
          rooms,
          metrics,
          emitLog,
          "password_failed",
          locked,
        );
        if (locked) {
          sendError(
            session.socket,
            "ROOM_LOCKED",
            "That room is locked after too many failed password attempts.",
          );
        } else {
          sendError(
            session.socket,
            "BAD_PASSWORD",
            "That password does not match.",
            Math.max(0, ROOM_AUTH_FAILURE_LIMIT - room.passwordFailures),
          );
        }
        return;
      }
      rooms.resetPasswordFailures(room);
    }

    rooms.addPeer(room, session.id, session.socket);
    session.roomSlug = room.slug;
    if (isUploaderRejoin) {
      room.uploaderId = session.id;
    }
    sendMessage(session.socket, {
      t: "joined",
      peerId: session.id,
      role: isUploaderRejoin ? "uploader" : "downloader",
    });
    emitLog("room_joined", {
      peerId: session.id,
      ip: session.ip,
      roomCount: rooms.rooms.size,
    });
    if (isUploaderRejoin) {
      for (const [peerId, peer] of room.peers) {
        if (peerId !== session.id) {
          sendMessage(session.socket, { t: "peer-joined", peerId });
          sendMessage(peer, { t: "peer-joined", peerId: session.id });
        }
      }
    } else {
      const uploader = room.peers.get(room.uploaderId);
      if (uploader !== undefined) {
        sendMessage(uploader, { t: "peer-joined", peerId: session.id });
      }
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

  if (message.t === "stat") {
    const room = getRoomForSession(session, rooms);
    if (room === undefined) {
      return;
    }
    metrics.connections[message.route] += 1;
    rooms.touchRoom(room);
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

  leaveSession(session, rooms, emitLog);
  session.socket.close(1000, "Closed by client");
};

const attachWebSocketConnection = (
  socket: WebSocket,
  request: IncomingMessage,
  rooms: RoomRegistry,
  rateLimiter: RateLimiter,
  turnConfig: TurnConfig,
  trustedProxies: readonly string[],
  metrics: MetricsState,
  emitLog: EmitLog,
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

  emitLog("ws_open", { peerId: session.id, ip: session.ip });

  socket.on("message", (rawData) => {
    void handleMessage(
      session,
      rawData,
      rooms,
      rateLimiter,
      turnConfig,
      metrics,
      emitLog,
    ).catch(() => {
      metrics.malformed += 1;
      emitLog("malformed", {
        peerId: session.id,
        ip: session.ip,
        code: "MALFORMED",
        roomCount: rooms.rooms.size,
      });
      sendError(
        session.socket,
        "MALFORMED",
        "The server could not process that message.",
      );
      session.socket.close(1011, "Message processing failed");
    });
  });
  socket.once("close", () => {
    leaveSession(session, rooms, emitLog);
    emitLog("ws_close", {
      peerId: session.id,
      ip: session.ip,
      roomCount: rooms.rooms.size,
    });
  });
};

const renderMetrics = (
  rooms: RoomRegistry,
  sessions: ReadonlySet<WebSocket>,
  metrics: MetricsState,
): string => {
  const activeTransfers = [...rooms.rooms.values()].filter(
    (room) => room.peers.size === 2,
  ).length;
  return [
    "# HELP mayo_rooms_active Active signaling rooms.",
    "# TYPE mayo_rooms_active gauge",
    `mayo_rooms_active ${rooms.rooms.size}`,
    "# HELP mayo_peers_connected Live WebSocket connections.",
    "# TYPE mayo_peers_connected gauge",
    `mayo_peers_connected ${sessions.size}`,
    "# HELP mayo_transfers_active Rooms with two connected peers.",
    "# TYPE mayo_transfers_active gauge",
    `mayo_transfers_active ${activeTransfers}`,
    "# HELP mayo_rooms_created_total Rooms created by clients.",
    "# TYPE mayo_rooms_created_total counter",
    `mayo_rooms_created_total ${metrics.roomsCreated}`,
    "# HELP mayo_rooms_reaped_total Rooms removed by the idle reaper.",
    "# TYPE mayo_rooms_reaped_total counter",
    `mayo_rooms_reaped_total ${metrics.roomsReaped}`,
    "# HELP mayo_password_failures_total Failed room password attempts.",
    "# TYPE mayo_password_failures_total counter",
    `mayo_password_failures_total ${metrics.passwordFailures}`,
    "# HELP mayo_token_failures_total Failed uploader-token attempts.",
    "# TYPE mayo_token_failures_total counter",
    `mayo_token_failures_total ${metrics.tokenFailures}`,
    "# HELP mayo_rooms_locked_total Rooms locked after authentication failures.",
    "# TYPE mayo_rooms_locked_total counter",
    `mayo_rooms_locked_total ${metrics.roomsLocked}`,
    "# HELP mayo_rate_limited_total Rate-limited requests by action.",
    "# TYPE mayo_rate_limited_total counter",
    `mayo_rate_limited_total{action="create"} ${metrics.rateLimited.create}`,
    `mayo_rate_limited_total{action="join"} ${metrics.rateLimited.join}`,
    `mayo_rate_limited_total{action="message"} ${metrics.rateLimited.message}`,
    "# HELP mayo_malformed_total Malformed signaling messages.",
    "# TYPE mayo_malformed_total counter",
    `mayo_malformed_total ${metrics.malformed}`,
    "# HELP mayo_connections_total WebRTC connections by route.",
    "# TYPE mayo_connections_total counter",
    `mayo_connections_total{route="direct"} ${metrics.connections.direct}`,
    `mayo_connections_total{route="relay"} ${metrics.connections.relay}`,
    "",
  ].join("\n");
};

const hasLocalMetricsAccess = (
  request: IncomingMessage,
  trustedProxies: readonly string[],
): boolean => {
  const clientIp = getClientIp(
    request.socket.remoteAddress,
    request.headers["x-forwarded-for"],
    trustedProxies,
  );
  return clientIp === "127.0.0.1" || clientIp === "::1";
};

const hasMetricsToken = (
  authorization: string | undefined,
  expectedToken: string,
): boolean => {
  const prefix = "Bearer ";
  const supplied =
    authorization?.startsWith(prefix) === true
      ? authorization.slice(prefix.length)
      : "";
  const expected = Buffer.from(expectedToken);
  const received = Buffer.from(supplied);
  return (
    expected.length === received.length && timingSafeEqual(expected, received)
  );
};

/** Creates the Phase 1 HTTP and WebSocket signaling server. */
export const createServer = (options: ServerOptions = {}): ServerHandle => {
  const logLevel =
    process.env.LOG_LEVEL ??
    (process.env.NODE_ENV === "test" || process.env.VITEST === "true"
      ? "silent"
      : "info");
  const app = Fastify({
    logger: {
      level: logLevel,
      base: null,
      timestamp: () => `,"ts":${Date.now()}`,
      formatters: {
        level: (label) => ({ level: label }),
      },
      ...(options.logStream === undefined ? {} : { stream: options.logStream }),
    },
    logController: new LogController({ disableRequestLogging: true }),
  });
  const metrics = createMetricsState();
  const emitLog: EmitLog = (event, fields = {}) => {
    app.log.info({ event, ...fields });
  };
  const rooms =
    options.roomRegistry ??
    createRoomRegistry({
      ttlMs: parseRoomTtlEnv(process.env.ROOM_TTL_MS, ROOM_TTL_MS),
      ...(process.env.ROOM_STATE_PATH === undefined
        ? {}
        : { statePath: process.env.ROOM_STATE_PATH }),
    });
  const previousReapHandler = rooms.onRoomReaped;
  rooms.onRoomReaped = (room, roomCount) => {
    previousReapHandler?.(room, roomCount);
    metrics.roomsReaped += 1;
    emitLog("room_reaped", { roomCount });
  };
  const rateLimiter =
    options.rateLimiter ?? createRateLimiter(parseRateLimitOverrides());
  const turnConfig = options.turnConfig ?? createTurnConfig();
  const trustedProxies = options.trustedProxies ?? parseTrustedProxyList();
  const host = options.host ?? process.env.HOST ?? "0.0.0.0";
  const wsServer = new WebSocketServer({ noServer: true });
  const sessions = new Set<WebSocket>();
  const metricsToken = process.env.METRICS_TOKEN;
  const webRoot =
    options.webRoot ??
    process.env.WEB_ROOT ??
    fileURLToPath(new URL("../../web/dist/", import.meta.url));

  app.get("/healthz", async () => ({ ok: true }));
  app.get("/metrics", async (request, reply) => {
    const authorized =
      metricsToken === undefined || metricsToken === ""
        ? hasLocalMetricsAccess(request.raw, trustedProxies)
        : hasMetricsToken(request.headers.authorization, metricsToken);
    if (!authorized) {
      return reply.code(404).send();
    }
    return reply
      .type("text/plain; version=0.0.4")
      .send(renderMetrics(rooms, sessions, metrics));
  });
  if (existsSync(`${webRoot}/index.html`)) {
    app.register(fastifyStatic, { root: webRoot });
    app.setNotFoundHandler(async (request, reply) => {
      if (
        (request.method === "GET" || request.method === "HEAD") &&
        request.headers.accept?.includes("text/html") === true
      ) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({
        message: `Route ${request.method}:${request.url} not found`,
        error: "Not Found",
        statusCode: 404,
      });
    });
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
      metrics,
      emitLog,
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
