import { describe, expect, it } from "vitest";
import { parseCtrlMessage } from "../src/net/protocol";

describe("ctrl protocol validation", () => {
  it("accepts strict ping and pong frames", () => {
    expect(
      parseCtrlMessage(JSON.stringify({ t: "ping", nonce: "n-1" })),
    ).toEqual({
      t: "ping",
      nonce: "n-1",
    });
    expect(
      parseCtrlMessage(JSON.stringify({ t: "pong", nonce: "n-1" })),
    ).toEqual({
      t: "pong",
      nonce: "n-1",
    });
  });

  it("rejects malformed or unexpected ctrl frames", () => {
    expect(
      parseCtrlMessage(JSON.stringify({ t: "ping", nonce: 1 })),
    ).toBeUndefined();
    expect(
      parseCtrlMessage(
        JSON.stringify({ t: "ping", nonce: "n-1", extra: true }),
      ),
    ).toBeUndefined();
    expect(parseCtrlMessage("not json")).toBeUndefined();
    expect(
      parseCtrlMessage(JSON.stringify({ t: "signal", payload: {} })),
    ).toBeUndefined();
    expect(parseCtrlMessage(new ArrayBuffer(0))).toBeUndefined();
  });
});
