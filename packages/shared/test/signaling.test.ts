import { describe, expect, it } from "vitest";
import { signalingMessageSchema } from "../src/signaling.js";

const validMessages = [
  { t: "create", password: "sauce" },
  { t: "join", slug: "mushroom-olive-basil-42" },
  {
    t: "join",
    slug: "mushroom-olive-basil-42",
    uploaderToken: "token",
  },
  { t: "signal", to: "peer-2", payload: { type: "offer", sdp: "opaque" } },
  { t: "ice-config" },
  { t: "close" },
  { t: "stat", event: "connected", route: "direct" },
  { t: "stat", event: "connected", route: "relay" },
  { t: "created", slug: "mushroom-olive-basil-42", uploaderToken: "token" },
  { t: "joined", peerId: "peer-2", role: "downloader" },
  { t: "peer-joined", peerId: "peer-2" },
  { t: "peer-left", peerId: "peer-2" },
  { t: "signal", from: "peer-2", payload: ["opaque", 1, true] },
  { t: "ice-config", iceServers: [{ urls: "stun:mayo.pizza:3478" }] },
  {
    t: "error",
    code: "BAD_PASSWORD",
    message: "That password does not match.",
    attemptsRemaining: 4,
  },
  {
    t: "error",
    code: "PASSWORD_REQUIRED",
    message: "That room requires a password.",
  },
  {
    t: "error",
    code: "ROOM_LOCKED",
    message: "That room is locked.",
  },
] as const;

const invalidMessages = [
  { t: "create", password: 42 },
  { t: "join" },
  { t: "join", slug: "mushroom-olive-basil-42", unexpected: true },
  { t: "signal", to: 7, payload: null },
  { t: "ice-config", unexpected: true },
  { t: "CLOSE" },
  { t: "created", slug: "mushroom-olive-basil-42" },
  { t: "joined", peerId: "peer-2", role: "sender" },
  { t: "peer-joined", peerId: 7 },
  { t: "peer-left" },
  { t: "signal", from: "peer-2" },
  { t: "stat", event: "connected", route: "other" },
  { t: "stat", event: "connected", route: "direct", extra: true },
  { t: "ice-config", iceServers: "stun:mayo.pizza:3478" },
  { t: "error", code: "NOT_A_REAL_CODE", message: "nope" },
  {
    t: "error",
    code: "BAD_PASSWORD",
    message: "nope",
    attemptsRemaining: -1,
  },
  {
    t: "error",
    code: "BAD_PASSWORD",
    message: "nope",
    attemptsRemaining: 1.5,
  },
  {
    t: "error",
    code: "PASSWORD_REQUIRED",
    message: "nope",
    unexpected: true,
  },
  {
    t: "error",
    code: "PASSWORD_REQUIRED",
    message: "nope",
    attemptsRemaining: 4,
  },
] as const;

describe("signalingMessageSchema", () => {
  it.each(validMessages)(
    "accepts and round-trips the $t variant",
    (message) => {
      expect(signalingMessageSchema.parse(message)).toEqual(message);
    },
  );

  it.each(invalidMessages)("rejects the malformed $t variant", (message) => {
    expect(signalingMessageSchema.safeParse(message).success).toBe(false);
  });
});
