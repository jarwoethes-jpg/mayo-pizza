import { randomInt } from "node:crypto";
import type WebSocket from "ws";

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
  peers: Map<string, WebSocket>;
  passwordHash?: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface RoomRegistry {
  rooms: Map<string, Room>;
  ttlMs: number;
  createRoom: (uploaderId: string, passwordHash?: string) => Room;
  getRoom: (slug: string) => Room | undefined;
  touchRoom: (room: Room, at?: number) => void;
  addPeer: (room: Room, peerId: string, socket: WebSocket) => void;
  removePeer: (room: Room, peerId: string) => void;
  dispose: () => void;
}

export interface RoomRegistryOptions {
  now?: () => number;
  ttlMs?: number;
  startReaper?: boolean;
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
    createRoom: (uploaderId, passwordHash) => {
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
      };
      if (passwordHash !== undefined) {
        room.passwordHash = passwordHash;
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
      if (room.peers.size === 0) {
        rooms.delete(room.slug);
      }
    },
    dispose: () => {
      if (timer !== undefined) {
        clearInterval(timer);
      }
    },
  };

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
      peer.close(1000, "Room expired");
    }
    registry.rooms.delete(slug);
    reaped += 1;
  }
  return reaped;
};
