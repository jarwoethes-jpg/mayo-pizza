import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createIceServers,
  createTurnConfig,
  mintTurnCredentials,
} from "../src/turn.js";

describe("TURN credentials", () => {
  it("matches an independently computed HMAC-SHA1 vector", () => {
    const secret = "phase-one-test-secret";
    const config = createTurnConfig({ TURN_STATIC_SECRET: secret });
    const now = 1_700_000_000_000;
    const credentials = mintTurnCredentials("peer-123", config, now);
    const expected = createHmac("sha1", secret)
      .update(credentials.username)
      .digest("base64");

    expect(credentials.username).toBe("1700003600:peer-123");
    expect(credentials.credential).toBe(expected);
  });

  it("returns the plan's STUN and TURN server shapes", () => {
    const config = createTurnConfig({ TURN_STATIC_SECRET: "secret" });
    const iceServers = createIceServers("peer-123", config, 1_700_000_000_000);

    expect(iceServers).toEqual([
      { urls: ["stun:mayo.pizza:3478"] },
      {
        urls: [
          "turn:mayo.pizza:3478?transport=udp",
          "turn:mayo.pizza:3478?transport=tcp",
          "turns:turn.mayo.pizza:443?transport=tcp",
        ],
        username: "1700003600:peer-123",
        credential: expect.any(String),
      },
    ]);

    const emittedUrls = iceServers.flatMap(({ urls }) =>
      typeof urls === "string" ? [urls] : urls,
    );
    expect(emittedUrls.filter((url) => url.startsWith("turns:"))).toEqual([
      "turns:turn.mayo.pizza:443?transport=tcp",
    ]);
  });
});

describe("TURN server configuration", () => {
  it("defaults the TURNS host from the public hostname and uses port 443", () => {
    expect(createTurnConfig()).toMatchObject({
      turnsHost: "turn.mayo.pizza",
      turnsPort: 443,
    });
    expect(createTurnConfig({ PUBLIC_HOSTNAME: "example.com" })).toMatchObject({
      turnsHost: "turn.example.com",
      turnsPort: 443,
    });
  });

  it("allows TURNS host and port overrides", () => {
    expect(
      createTurnConfig({ TURNS_HOST: "relay.example.com", TURNS_PORT: "8443" }),
    ).toMatchObject({
      turnsHost: "relay.example.com",
      turnsPort: 8443,
    });
  });

  it.each(["not-a-port", "0", "65536"])(
    "falls back to port 443 for invalid TURNS_PORT %s",
    (turnsPort) => {
      expect(createTurnConfig({ TURNS_PORT: turnsPort }).turnsPort).toBe(443);
    },
  );

  // WHY: coturn does not expand env vars in its config and treats config and CLI
  // static-auth-secret values as independently valid, so a literal placeholder
  // here is a publicly-known working credential.
  it("contains no unexpanded environment-variable placeholders", () => {
    const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
    const config = readFileSync(
      `${repositoryRoot}/infra/turnserver.conf`,
      "utf8",
    );

    expect(config).not.toMatch(/\$\{[^}]+\}/);
  });
});
