import { describe, expect, it } from "vitest";
import {
  createRateLimiter,
  getClientIp,
  parseRateLimitEnv,
  parseRateLimitOverrides,
  parseTrustedProxyList,
} from "../src/ratelimit.js";

describe("rate limiter", () => {
  it("allows exactly the configured threshold for each action", () => {
    const limiter = createRateLimiter();

    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(limiter.consume("198.51.100.1", "create", 1_000).allowed).toBe(
        true,
      );
    }
    expect(limiter.consume("198.51.100.1", "create", 1_000).allowed).toBe(
      false,
    );

    for (let attempt = 0; attempt < 60; attempt += 1) {
      expect(limiter.consume("198.51.100.1", "join", 1_000).allowed).toBe(true);
    }
    expect(limiter.consume("198.51.100.1", "join", 1_000).allowed).toBe(false);

    for (let attempt = 0; attempt < 100; attempt += 1) {
      expect(limiter.consume("198.51.100.1", "message", 1_000).allowed).toBe(
        true,
      );
    }
    expect(limiter.consume("198.51.100.1", "message", 1_000).allowed).toBe(
      false,
    );
  });

  it("resets a fixed window after its duration", () => {
    const limiter = createRateLimiter();

    for (let attempt = 0; attempt < 10; attempt += 1) {
      limiter.consume("198.51.100.2", "create", 1_000);
    }

    expect(limiter.consume("198.51.100.2", "create", 3_601_001).allowed).toBe(
      true,
    );
  });

  it("uses forwarded addresses only from trusted proxies", () => {
    const trustedProxies = parseTrustedProxyList("10.0.0.2, ::1");

    expect(getClientIp("10.0.0.2", "203.0.113.7", trustedProxies)).toBe(
      "203.0.113.7",
    );
    expect(
      getClientIp("10.0.0.2", "203.0.113.7, 10.0.0.2", trustedProxies),
    ).toBe("10.0.0.2");
    expect(
      getClientIp("10.0.0.2", " 203.0.113.7 , 5.6.7.8 ", trustedProxies),
    ).toBe("5.6.7.8");
    expect(
      getClientIp("10.0.0.2", "203.0.113.7, 5.6.7.8, ", trustedProxies),
    ).toBe("5.6.7.8");
    expect(
      getClientIp("::ffff:10.0.0.2", "::ffff:203.0.113.7", trustedProxies),
    ).toBe("203.0.113.7");
    expect(getClientIp("198.51.100.3", "203.0.113.7", trustedProxies)).toBe(
      "198.51.100.3",
    );
  });

  it.each([
    ["12", 12],
    [undefined, 10],
    ["", 10],
    ["0", 10],
    ["-5", 10],
    ["abc", 10],
    ["12.5", 10],
  ] as const)(
    "accepts only positive integer env limits: %s",
    (value, expected) => {
      expect(parseRateLimitEnv(value, 10)).toBe(expected);
    },
  );

  it("maps the rate-limit environment overrides", () => {
    expect(
      parseRateLimitOverrides({
        RATE_LIMIT_CREATE: "11",
        RATE_LIMIT_JOIN: "22",
        RATE_LIMIT_MESSAGE: "33",
      }),
    ).toEqual({ createLimit: 11, joinLimit: 22, messageLimit: 33 });
  });
});
