import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { ReceiverProcessor } from "../src/worker/receiverLogic";

describe("receiver resume hash snapshots", () => {
  it("adopts the last durable snapshot before hashing the resumed suffix", () => {
    const events: Array<{ t: string; [key: string]: unknown }> = [];
    const processor = new ReceiverProcessor((message) => {
      events.push(message as { t: string; [key: string]: unknown });
    });
    const first = Uint8Array.from([1, 2, 3, 4]).buffer;
    const second = Uint8Array.from([5, 6, 7, 8]).buffer;

    processor.handle({
      t: "init",
      transferId: "transfer-1",
      offset: 0,
      totalBytes: 8,
    });
    processor.handle({ t: "data", buffer: first });
    processor.handle({ t: "commit", chunkId: "0" });
    processor.handle({ t: "resume-seed" });
    processor.handle({ t: "data", buffer: second });
    processor.handle({ t: "commit", chunkId: "0" });
    processor.handle({ t: "finish" });

    const done = events.find((event) => event.t === "done");
    expect(done).toMatchObject({
      t: "done",
      bytesDone: 8,
      sha256: bytesToHex(sha256(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]))),
    });
  });

  it("does not seed while a sink commit is still pending", () => {
    const events: Array<{ t: string; [key: string]: unknown }> = [];
    const processor = new ReceiverProcessor((message) => {
      events.push(message as { t: string; [key: string]: unknown });
    });

    processor.handle({
      t: "init",
      transferId: "transfer-2",
      offset: 0,
      totalBytes: 4,
    });
    processor.handle({ t: "data", buffer: new ArrayBuffer(4) });
    processor.handle({ t: "resume-seed" });

    expect(events.at(-1)).toEqual({
      t: "error",
      message: "The receiver cannot resume before sink writes drain.",
    });
  });
});
