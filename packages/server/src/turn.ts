import { createHmac } from "node:crypto";

const DEFAULT_PUBLIC_HOSTNAME = "mayo.pizza";

export interface TurnConfig {
  staticSecret: string;
  stunHost: string;
  turnHost: string;
  stunPort: number;
  turnPort: number;
}

export interface TurnCredentials {
  username: string;
  credential: string;
}

const parsePort = (value: string | undefined, fallback: number): number => {
  const port = Number.parseInt(value ?? "", 10);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : fallback;
};

/** Builds TURN settings from deployment environment variables. */
export const createTurnConfig = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): TurnConfig => {
  const publicHostname = env.PUBLIC_HOSTNAME ?? DEFAULT_PUBLIC_HOSTNAME;
  return {
    staticSecret: env.TURN_STATIC_SECRET ?? "",
    stunHost: env.STUN_HOST ?? publicHostname,
    turnHost: env.TURN_HOST ?? publicHostname,
    stunPort: parsePort(env.STUN_PORT, 3478),
    turnPort: parsePort(env.TURN_PORT, 3478),
  };
};

/** Mints the time-limited coturn credential for one signaling peer. */
export const mintTurnCredentials = (
  peerId: string,
  config: TurnConfig,
  now = Date.now(),
): TurnCredentials => {
  if (config.staticSecret === "") {
    throw new Error("TURN_STATIC_SECRET is not configured.");
  }

  const username = `${Math.floor(now / 1000) + 3600}:${peerId}`;
  const credential = createHmac("sha1", config.staticSecret)
    .update(username)
    .digest("base64");
  return { username, credential };
};

/** Returns the exact STUN/TURN server list required by the wire contract. */
export const createIceServers = (
  peerId: string,
  config: TurnConfig,
  now = Date.now(),
): Array<{
  urls: string | string[];
  username?: string;
  credential?: string;
}> => {
  const credentials = mintTurnCredentials(peerId, config, now);
  return [
    { urls: [`stun:${config.stunHost}:${config.stunPort}`] },
    {
      urls: [
        // WHY: coturn has no certificate material for a TLS listener, so we
        // deliberately omit TLS-wrapped `turns:` URLs.
        `turn:${config.turnHost}:${config.turnPort}?transport=udp`,
        `turn:${config.turnHost}:${config.turnPort}?transport=tcp`,
      ],
      username: credentials.username,
      credential: credentials.credential,
    },
  ];
};
