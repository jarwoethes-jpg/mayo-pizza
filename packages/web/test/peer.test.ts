import { describe, expect, it } from "vitest";
import { RemoteIceCandidateQueue } from "../src/net/peer";

describe("remote ICE candidate queue", () => {
  it("flushes candidates in arrival order", async () => {
    const queue = new RemoteIceCandidateQueue();
    const first = { candidate: "candidate-1", sdpMid: "0", sdpMLineIndex: 0 };
    const second = { candidate: "candidate-2", sdpMid: "0", sdpMLineIndex: 0 };
    const flushed: string[] = [];

    queue.enqueue(first);
    queue.enqueue(second);
    expect(queue.size).toBe(2);
    await queue.flush(async (candidate) => {
      await Promise.resolve();
      flushed.push(candidate.candidate);
    });

    expect(flushed).toEqual(["candidate-1", "candidate-2"]);
    expect(queue.size).toBe(0);
  });
});
