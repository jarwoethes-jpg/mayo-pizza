import argon2 from "argon2";
import { describe, expect, it } from "vitest";
import { ARGON2_OPTIONS } from "../src/index.js";

describe("Argon2id deployment parameters", () => {
  it("uses the OWASP baseline for the bounded online threat model", () => {
    expect(ARGON2_OPTIONS).toMatchObject({
      type: argon2.argon2id,
      memoryCost: 19 * 1024,
      timeCost: 2,
      parallelism: 1,
    });
    expect(ARGON2_OPTIONS.parallelism).toBe(1);
    expect(ARGON2_OPTIONS.memoryCost * 5).toBe(19 * 5 * 1024);
    expect(ARGON2_OPTIONS.memoryCost * 5).toBeLessThan(4 * 1024 * 1024);
  });

  it("verifies hashes using their stored parameters", async () => {
    const existingHash = await argon2.hash("secret", {
      type: argon2.argon2id,
      memoryCost: 32 * 1024,
      timeCost: 2,
      parallelism: 1,
    });

    expect(await argon2.verify(existingHash, "secret")).toBe(true);
  });
});
