const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

export const DEFAULT_TRUSTED_PROXIES = ["127.0.0.1", "::1"] as const;

export type RateLimitAction = "create" | "join" | "message";

interface RateLimitWindow {
  startedAt: number;
  count: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

export interface RateLimiter {
  consume: (
    ip: string,
    action: RateLimitAction,
    now?: number,
  ) => RateLimitResult;
  clear: () => void;
}

export interface RateLimiterOptions {
  createLimit?: number;
  joinLimit?: number;
  messageLimit?: number;
}

const limits: Record<RateLimitAction, { count: number; windowMs: number }> = {
  create: { count: 10, windowMs: HOUR_MS },
  join: { count: 60, windowMs: HOUR_MS },
  message: { count: 100, windowMs: MINUTE_MS },
};

const normaliseAddress = (address: string): string =>
  address.trim().replace(/^::ffff:/i, "");

/** Parses the comma-separated trusted-proxy environment value. */
export const parseTrustedProxyList = (
  value = process.env.TRUSTED_PROXIES,
): readonly string[] => {
  if (value === undefined || value.trim() === "") {
    return DEFAULT_TRUSTED_PROXIES;
  }
  return value
    .split(",")
    .map(normaliseAddress)
    .filter((address) => address.length > 0);
};

/** Resolves the client IP while ignoring spoofed forwarding headers. */
export const getClientIp = (
  remoteAddress: string | undefined,
  forwardedFor: string | string[] | undefined,
  trustedProxies: readonly string[] = parseTrustedProxyList(),
): string => {
  const remote = normaliseAddress(remoteAddress ?? "unknown");
  const trusted = trustedProxies.some(
    (proxy) => normaliseAddress(proxy) === remote,
  );
  if (!trusted) {
    return remote;
  }

  const header = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor;
  const forwardedClient = header?.split(",")[0]?.trim();
  return forwardedClient === undefined || forwardedClient === ""
    ? remote
    : normaliseAddress(forwardedClient);
};

/** Creates fixed-window per-IP limits for room creation, joins, and messages. */
export const createRateLimiter = (
  options: RateLimiterOptions = {},
): RateLimiter => {
  const configuredLimits: Record<
    RateLimitAction,
    { count: number; windowMs: number }
  > = {
    create: {
      count: options.createLimit ?? limits.create.count,
      windowMs: HOUR_MS,
    },
    join: { count: options.joinLimit ?? limits.join.count, windowMs: HOUR_MS },
    message: {
      count: options.messageLimit ?? limits.message.count,
      windowMs: MINUTE_MS,
    },
  };
  const windows = new Map<string, RateLimitWindow>();

  return {
    consume: (ip, action, now = Date.now()) => {
      const key = `${ip}:${action}`;
      const configured = configuredLimits[action];
      const existing = windows.get(key);
      const window =
        existing === undefined ||
        now - existing.startedAt >= configured.windowMs
          ? { startedAt: now, count: 0 }
          : existing;

      if (existing === undefined || window !== existing) {
        windows.set(key, window);
      }

      const allowed = window.count < configured.count;
      if (allowed) {
        window.count += 1;
      }

      return {
        allowed,
        remaining: Math.max(0, configured.count - window.count),
        retryAfterMs: allowed
          ? 0
          : Math.max(0, configured.windowMs - (now - window.startedAt)),
      };
    },
    clear: () => {
      windows.clear();
    },
  };
};
