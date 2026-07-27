import { randomInt } from "node:crypto";
import WebSocket from "ws";

const crustTerms = [
  "artisan",
  "crispy",
  "cheesy",
  "charred",
  "bubbly",
  "golden",
  "thin",
  "thick",
  "stuffed",
  "sourdough",
  "woodfired",
  "brickoven",
  "handtossed",
  "blistered",
  "savory",
  "herbed",
  "roasted",
  "smoky",
  "zesty",
  "garlicky",
  "buttery",
  "flaky",
  "rustic",
  "classic",
  "spicy",
  "sweet",
  "tangy",
  "fresh",
  "loaded",
  "melty",
  "stretchy",
  "gooey",
  "toasty",
  "crunchy",
  "tender",
  "hearty",
  "lively",
  "sunny",
  "peppery",
  "creamy",
  "bright",
  "bold",
  "saucy",
  "earthy",
  "fragrant",
  "basil",
  "tomato",
  "olive",
  "pesto",
  "marinara",
  "calzone",
  "focaccia",
  "sicilian",
  "neapolitan",
  "roman",
  "detroit",
  "chicago",
  "brooklyn",
  "granny",
  "tavern",
  "grandma",
  "coal",
  "fire",
  "hearth",
] as const;

const toppingTerms = [
  "mushroom",
  "olive",
  "basil",
  "pepper",
  "onion",
  "garlic",
  "tomato",
  "spinach",
  "arugula",
  "oregano",
  "thyme",
  "rosemary",
  "sausage",
  "pepperoni",
  "salami",
  "prosciutto",
  "pancetta",
  "bacon",
  "chicken",
  "anchovy",
  "tuna",
  "shrimp",
  "artichoke",
  "eggplant",
  "zucchini",
  "broccoli",
  "corn",
  "pineapple",
  "jalapeno",
  "chili",
  "caper",
  "truffle",
  "ricotta",
  "mozzarella",
  "burrata",
  "parmesan",
  "provolone",
  "gorgonzola",
  "feta",
  "cheddar",
  "pecorino",
  "meatball",
  "ham",
  "beef",
  "pork",
  "fennel",
  "leek",
  "shallot",
  "radicchio",
  "kale",
  "egg",
  "potato",
  "fig",
  "pear",
  "apple",
  "honey",
  "walnut",
  "almond",
  "pistachio",
  "sesame",
  "lemon",
  "balsamic",
  "speck",
  "mortadella",
] as const;

/** The 4,096-token pizza wordlist; three tokens and two digits provide 42.6 bits. */
export const PIZZA_WORDLIST: readonly string[] = Object.freeze(
  crustTerms.flatMap((crust) =>
    toppingTerms.map((topping) => `${crust}${topping}`),
  ),
);

// 4,096^3 * 100 possible slugs = 2^42.64, keeping the capability above 40 bits.
export const ROOM_TTL_MS = 30 * 60 * 1000;
export const ROOM_REAPER_INTERVAL_MS = 60 * 1000;
export const ROOM_AUTH_FAILURE_LIMIT = 5;

const isPositiveSafeInteger = (value: number): boolean =>
  Number.isSafeInteger(value) && value > 0;

/** Parses a positive integer room TTL, falling back for invalid values. */
export const parseRoomTtlEnv = (
  value: string | undefined,
  fallback: number,
): number => {
  const trimmed = value?.trim();
  if (trimmed === undefined || !/^\d+$/.test(trimmed)) {
    return fallback;
  }
  const parsed = Number(trimmed);
  return isPositiveSafeInteger(parsed) ? parsed : fallback;
};

/** Generates a capability slug without modulo-biased random selection. */
export const generateSlug = (): string => {
  const words = Array.from(
    { length: 3 },
    () => PIZZA_WORDLIST[randomInt(PIZZA_WORDLIST.length)],
  );
  const digits = randomInt(100).toString().padStart(2, "0");
  return `${words.join("-")}-${digits}`;
};

export interface Room {
  slug: string;
  uploaderId: string;
  uploaderToken?: string;
  peers: Map<string, WebSocket>;
  passwordHash?: string;
  createdAt: number;
  lastSeenAt: number;
  passwordFailures: number;
  tokenFailures: number;
  lockedAt?: number;
}

export type RoomReapedHandler = (room: Room, roomCount: number) => void;

export interface RoomRegistry {
  rooms: Map<string, Room>;
  ttlMs: number;
  createRoom: (
    uploaderId: string,
    passwordHash?: string,
    uploaderToken?: string,
  ) => Room;
  getRoom: (slug: string) => Room | undefined;
  touchRoom: (room: Room, at?: number) => void;
  addPeer: (room: Room, peerId: string, socket: WebSocket) => void;
  removePeer: (room: Room, peerId: string) => void;
  recordPasswordFailure: (room: Room, at?: number) => boolean;
  recordTokenFailure: (room: Room, at?: number) => boolean;
  resetPasswordFailures: (room: Room) => void;
  resetTokenFailures: (room: Room) => void;
  onRoomReaped?: RoomReapedHandler;
  dispose: () => void;
}

export interface RoomRegistryOptions {
  now?: () => number;
  ttlMs?: number;
  startReaper?: boolean;
  onRoomReaped?: RoomReapedHandler;
}

/** Creates the in-memory room map and its idle-room reaper. */
export const createRoomRegistry = (
  options: RoomRegistryOptions = {},
): RoomRegistry => {
  const rooms = new Map<string, Room>();
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? ROOM_TTL_MS;
  const timer =
    options.startReaper === false
      ? undefined
      : setInterval(() => {
          reapIdleRooms(registry, now());
        }, ROOM_REAPER_INTERVAL_MS);

  timer?.unref();

  const registry: RoomRegistry = {
    rooms,
    ttlMs,
    createRoom: (uploaderId, passwordHash, uploaderToken) => {
      let slug = generateSlug();
      while (rooms.has(slug)) {
        slug = generateSlug();
      }

      const timestamp = now();
      const room: Room = {
        slug,
        uploaderId,
        peers: new Map(),
        createdAt: timestamp,
        lastSeenAt: timestamp,
        passwordFailures: 0,
        tokenFailures: 0,
      };
      if (passwordHash !== undefined) {
        room.passwordHash = passwordHash;
      }
      if (uploaderToken !== undefined) {
        room.uploaderToken = uploaderToken;
      }
      rooms.set(slug, room);
      return room;
    },
    getRoom: (slug) => rooms.get(slug),
    touchRoom: (room, at = now()) => {
      room.lastSeenAt = at;
    },
    addPeer: (room, peerId, socket) => {
      room.peers.set(peerId, socket);
      room.lastSeenAt = now();
    },
    removePeer: (room, peerId) => {
      room.peers.delete(peerId);
      room.lastSeenAt = now();
      // Keep the capability alive after a transient disconnect; the TTL
      // reaper, rather than peer count, owns room deletion.
    },
    recordPasswordFailure: (room, at = now()) => {
      if (room.lockedAt !== undefined) {
        return false;
      }
      room.passwordFailures += 1;
      if (
        room.passwordFailures >= ROOM_AUTH_FAILURE_LIMIT &&
        room.lockedAt === undefined
      ) {
        room.lockedAt = at;
        return true;
      }
      return false;
    },
    recordTokenFailure: (room) => {
      room.tokenFailures += 1;
      // WHY: uploader tokens are random 32-byte capabilities; per-IP joins
      // already bound guessing, so token failures must not brick the room.
      return false;
    },
    resetPasswordFailures: (room) => {
      room.passwordFailures = 0;
    },
    resetTokenFailures: (room) => {
      room.tokenFailures = 0;
    },
    dispose: () => {
      if (timer !== undefined) {
        clearInterval(timer);
      }
    },
  };

  if (options.onRoomReaped !== undefined) {
    registry.onRoomReaped = options.onRoomReaped;
  }

  return registry;
};

/** Deletes rooms whose last activity is beyond the configured idle TTL. */
export const reapIdleRooms = (
  registry: RoomRegistry,
  at = Date.now(),
): number => {
  let reaped = 0;
  for (const [slug, room] of registry.rooms) {
    if (at - room.lastSeenAt <= registry.ttlMs) {
      continue;
    }

    for (const peer of room.peers.values()) {
      if (peer.readyState === WebSocket.OPEN || peer.readyState === undefined) {
        peer.send(
          JSON.stringify({
            t: "error",
            code: "BAD_SLUG",
            message: "That room has expired.",
          }),
        );
      }
      peer.close(1001, "Room expired");
    }
    registry.rooms.delete(slug);
    registry.onRoomReaped?.(room, registry.rooms.size);
    reaped += 1;
  }
  return reaped;
};
