import { describe, expect, it } from "vitest";
import { ctrlMessageSchema } from "../src/ctrl.js";

describe("ctrlMessageSchema", () => {
  it("accepts ping and pong", () => {
    expect(ctrlMessageSchema.parse({ t: "ping", nonce: "n-1" })).toEqual({
      t: "ping",
      nonce: "n-1",
    });
    expect(ctrlMessageSchema.parse({ t: "pong", nonce: "n-1" })).toEqual({
      t: "pong",
      nonce: "n-1",
    });
  });

  it("keeps ping/pong strict", () => {
    expect(
      ctrlMessageSchema.safeParse({ t: "ping", nonce: "n-1", extra: true })
        .success,
    ).toBe(false);
    expect(ctrlMessageSchema.safeParse({ t: "pong", nonce: 1 }).success).toBe(
      false,
    );
  });
});
