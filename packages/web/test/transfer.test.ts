import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it, vi } from "vitest";
import type { DataChannelPumpTarget } from "../src/net/transfer";
import {
  createTransferController,
  FRAME_SIZE,
  joinFrames,
  splitBuffer,
  WatermarkFramePump,
} from "../src/net/transfer";

class FakeDataChannel implements DataChannelPumpTarget {
  public bufferedAmount = 0;
  public readonly frames: Uint8Array[] = [];
  private readonly lowListeners = new Set<() => void>();

  public send(data: ArrayBufferView): void {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    this.frames.push(new Uint8Array(bytes));
    this.bufferedAmount += data.byteLength;
  }

  public addEventListener(
    _type: "bufferedamountlow",
    listener: () => void,
  ): void {
    this.lowListeners.add(listener);
  }

  public removeEventListener(
    _type: "bufferedamountlow",
    listener: () => void,
  ): void {
    this.lowListeners.delete(listener);
  }

  public drain(bytes: number): void {
    this.bufferedAmount = Math.max(0, this.bufferedAmount - bytes);
    if (this.bufferedAmount <= 1) {
      for (const listener of this.lowListeners) {
        listener();
      }
    }
  }
}

describe("transfer framing", () => {
  it("splits and rejoins an ordered byte stream", () => {
    const source = Uint8Array.from(
      { length: FRAME_SIZE + 7 },
      (_, index) => index % 251,
    );
    const frames = splitBuffer(source.buffer, FRAME_SIZE);

    expect(frames.map((frame) => frame.byteLength)).toEqual([FRAME_SIZE, 7]);
    expect(joinFrames(frames)).toEqual(source);
  });

  it("hashes incrementally to the same digest as one whole payload", () => {
    const source = Uint8Array.from(
      { length: FRAME_SIZE + 7 },
      (_, index) => index % 251,
    );
    const incremental = sha256.create();
    for (const frame of splitBuffer(source.buffer, 97)) {
      incremental.update(frame);
    }

    expect(bytesToHex(incremental.digest())).toBe(bytesToHex(sha256(source)));
  });
});

describe("watermark frame pump", () => {
  it("pauses at the watermark and resumes on bufferedamountlow", () => {
    const channel = new FakeDataChannel();
    let drained = 0;
    let bufferedReports = 0;
    const testHighWatermark = 8;
    const pump = new WatermarkFramePump(channel, {
      frameSize: 4,
      highWatermark: testHighWatermark,
      onDrained: () => {
        drained += 1;
      },
      onBufferedAmount: () => {
        bufferedReports += 1;
      },
    });
    const source = Uint8Array.from({ length: 20 }, (_, index) => index);

    pump.push(source.buffer);
    expect(channel.bufferedAmount).toBe(testHighWatermark);
    expect(drained).toBe(0);
    expect(pump.maxBufferedAmountSeen).toBe(testHighWatermark);
    expect(bufferedReports).toBeLessThanOrEqual(2);

    channel.drain(testHighWatermark);
    channel.drain(testHighWatermark);
    expect(drained).toBe(1);
    expect(joinFrames(channel.frames)).toEqual(source);
  });

  it("removes its low-water listener and drops pending bytes on cancel", () => {
    const channel = new FakeDataChannel();
    let drained = 0;
    const pump = new WatermarkFramePump(channel, {
      frameSize: 4,
      highWatermark: 4,
      onDrained: () => {
        drained += 1;
      },
    });

    pump.push(new Uint8Array([1, 2, 3, 4, 5]).buffer);
    pump.cancel();
    channel.drain(4);

    expect(pump.hasPendingBuffer).toBe(false);
    expect(drained).toBe(0);
  });
});

describe("transfer cancellation", () => {
  it("terminates the worker and removes channel handlers", async () => {
    const ctrlHandlers = new Map<string, (message: unknown) => void>();
    const sent: unknown[] = [];
    const messageListeners = new Set<unknown>();
    const lowListeners = new Set<unknown>();
    const worker = {
      onmessage: null,
      onerror: null,
      postMessage: vi.fn(),
      terminate: vi.fn(),
    };
    const data = {
      readyState: "open",
      bufferedAmount: 0,
      send: vi.fn(),
      addEventListener: vi.fn((type: string, listener: unknown) => {
        (type === "message" ? messageListeners : lowListeners).add(listener);
      }),
      removeEventListener: vi.fn((type: string, listener: unknown) => {
        (type === "message" ? messageListeners : lowListeners).delete(listener);
      }),
    };
    const ctrl = {
      readyState: "open",
      send: (message: unknown) => sent.push(message),
      on: (type: string, handler: (message: unknown) => void) => {
        ctrlHandlers.set(type, handler);
        return () => ctrlHandlers.delete(type);
      },
    };
    const peer = {
      ctrl,
      data,
      maxMessageSize: undefined,
      on: () => () => false,
      onCtrl: (type: string, handler: (message: unknown) => void) => {
        ctrlHandlers.set(type, handler);
        return () => ctrlHandlers.delete(type);
      },
    };
    const controller = createTransferController("uploader", peer as never, {
      senderWorkerFactory: () => worker,
    });

    await controller.startSend(new File(["payload"], "payload.txt"));
    ctrlHandlers.get("request")?.({
      t: "request",
      transferId: (sent[0] as { transferId: string }).transferId,
      offset: 0,
    });
    controller.cancel("test cancel");

    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(messageListeners.size).toBe(0);
    expect(sent.at(-1)).toEqual({ t: "cancel", reason: "test cancel" });
  });
});
