import { describe, expect, it } from "vitest";
import { transferMessageSchema } from "../src/transfer.js";

const validMessages = [
  {
    t: "manifest",
    transferId: "transfer-1",
    mode: "single",
    items: [{ path: "pizza.txt", size: 5, lastModified: 1710000000000 }],
    totalBytes: 5,
    suggestedName: "pizza.txt",
  },
  { t: "start", transferId: "transfer-1", offset: 0 },
  {
    t: "done",
    transferId: "transfer-1",
    sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  },
  { t: "error", code: "TRANSFER_FAILED", message: "The transfer stopped." },
  { t: "request", transferId: "transfer-1", offset: 0 },
  { t: "ack", receivedBytes: 4194304 },
  { t: "complete", transferId: "transfer-1", verified: true },
  { t: "cancel", reason: "The receiver cancelled." },
] as const;

const invalidMessages = [
  { t: "manifest", transferId: "transfer-1", mode: "single" },
  { t: "start", transferId: "transfer-1", offset: "0" },
  { t: "done", transferId: "transfer-1", sha256: "not-a-sha256" },
  { t: "error", code: 7, message: "The transfer stopped." },
  { t: "request", offset: 0 },
  { t: "ack", receivedBytes: "4194304" },
  { t: "complete", transferId: "transfer-1", verified: "true" },
  { t: "cancel" },
] as const;

describe("transferMessageSchema", () => {
  it.each(validMessages)(
    "accepts and round-trips the $t variant",
    (message) => {
      expect(transferMessageSchema.parse(message)).toEqual(message);
    },
  );

  it.each(invalidMessages)("rejects the malformed $t variant", (message) => {
    expect(transferMessageSchema.safeParse(message).success).toBe(false);
  });
});
