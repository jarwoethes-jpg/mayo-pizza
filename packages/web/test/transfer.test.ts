import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { predictLength } from "client-zip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeZipPlan } from "../src/folder/zipPlan";
import type { DataChannelPumpTarget } from "../src/net/transfer";
import {
  createTransferController,
  FRAME_SIZE,
  joinFrames,
  splitBuffer,
  WatermarkFramePump,
} from "../src/net/transfer";
import {
  SINK_PROGRESS_WATCHDOG_MS,
  SINK_STALL_NOTICE_MS,
  SINK_SW_NO_CONSUMER_STALL_MS,
} from "../src/sink";

afterEach(() => {
  vi.useRealTimers();
});

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

const createChannelReadinessPeer = () => {
  const sent: unknown[] = [];
  const ctrlHandlers = new Map<string, (message: unknown) => void>();
  const eventListeners = new Map<string, Set<() => void>>();

  const makeCtrl = (readyState: "connecting" | "open") => ({
    readyState,
    send: (message: unknown) => sent.push(message),
  });
  const makeData = (readyState: "connecting" | "open") => ({
    readyState,
    bufferedAmount: 0,
    send: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  });

  const peer = {
    ctrl: makeCtrl("connecting"),
    data: makeData("connecting"),
    maxMessageSize: undefined,
    on: (event: string, listener: () => void) => {
      const listeners = eventListeners.get(event) ?? new Set<() => void>();
      listeners.add(listener);
      eventListeners.set(event, listeners);
      return () => listeners.delete(listener);
    },
    onCtrl: (type: string, handler: (message: unknown) => void) => {
      ctrlHandlers.set(type, handler);
      return () => ctrlHandlers.delete(type);
    },
  };

  const emit = (event: string): void => {
    for (const listener of eventListeners.get(event) ?? []) {
      listener();
    }
  };

  const openNewGeneration = (): void => {
    peer.ctrl = makeCtrl("connecting");
    peer.ctrl.readyState = "open";
    emit("ctrl-open");
    peer.data = makeData("connecting");
    peer.data.readyState = "open";
    emit("data-open");
  };

  return { ctrlHandlers, openNewGeneration, peer, sent };
};

interface ReceiverStallHarness {
  controller: ReturnType<typeof createTransferController>;
  emitWorkerDone: () => void;
  onError: ReturnType<typeof vi.fn>;
  onSinkStall: ReturnType<typeof vi.fn>;
  resolveWrite: () => void;
}

const createReceiverStallHarness = async (): Promise<ReceiverStallHarness> => {
  const ctrlHandlers = new Map<string, (message: unknown) => void>();
  let dataMessage: ((event: MessageEvent<unknown>) => void) | undefined;
  let writeCount = 0;
  let resolveWrite: (() => void) | undefined;
  const onError = vi.fn();
  const onSinkStall = vi.fn();
  const worker = {
    onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
    onerror: null as ((event: ErrorEvent) => void) | null,
    postMessage: vi.fn(),
    terminate: vi.fn(),
  };
  const data = {
    readyState: "open",
    bufferedAmount: 0,
    send: vi.fn(),
    addEventListener: vi.fn((type: string, listener: unknown) => {
      if (type === "message") {
        dataMessage = listener as (event: MessageEvent<unknown>) => void;
      }
    }),
    removeEventListener: vi.fn(),
  };
  const peer = {
    ctrl: { readyState: "open", send: vi.fn() },
    data,
    maxMessageSize: undefined,
    on: () => () => false,
    onCtrl: (type: string, handler: (message: unknown) => void) => {
      ctrlHandlers.set(type, handler);
      return () => ctrlHandlers.delete(type);
    },
  };
  const manifest = {
    t: "manifest" as const,
    transferId: "transfer-stall-watchdog",
    mode: "single" as const,
    items: [{ path: "file.bin", size: 8, lastModified: 0 }],
    totalBytes: 8,
    suggestedName: "file.bin",
  };
  const controller = createTransferController("downloader", peer as never, {
    onError,
    onSinkStall,
    receiverWorkerFactory: () => worker,
    sinkFactory: () => ({
      strategy: "null" as const,
      write: () => {
        writeCount += 1;
        return writeCount === 1
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              resolveWrite = resolve;
            });
      },
      close: vi.fn(),
      cancel: vi.fn(),
    }),
  });

  ctrlHandlers.get("manifest")?.(manifest);
  controller.acceptTransfer();
  await Promise.resolve();
  ctrlHandlers.get("start")?.({
    t: "start",
    transferId: manifest.transferId,
    offset: 0,
  });
  ctrlHandlers.get("done")?.({
    t: "done",
    transferId: manifest.transferId,
    sha256: "hash",
  });
  dataMessage?.({ data: new ArrayBuffer(4) } as MessageEvent<unknown>);
  worker.onmessage?.({
    data: {
      t: "chunk",
      chunkId: "0",
      buffer: new ArrayBuffer(4),
      bytesDone: 4,
      totalBytes: 8,
    },
  } as MessageEvent<unknown>);
  await Promise.resolve();
  dataMessage?.({ data: new ArrayBuffer(4) } as MessageEvent<unknown>);
  worker.onmessage?.({
    data: {
      t: "chunk",
      chunkId: "1",
      buffer: new ArrayBuffer(4),
      bytesDone: 8,
      totalBytes: 8,
    },
  } as MessageEvent<unknown>);

  return {
    controller,
    emitWorkerDone: () => {
      worker.onmessage?.({
        data: { t: "done", bytesDone: 8, sha256: "hash" },
      } as MessageEvent<unknown>);
    },
    onError,
    onSinkStall,
    resolveWrite: () => resolveWrite?.(),
  };
};

describe("transfer channel readiness", () => {
  it("sends a file manifest after a channel generation swap", async () => {
    const { openNewGeneration, peer, sent } = createChannelReadinessPeer();
    const controller = createTransferController("uploader", peer as never, {
      senderWorkerFactory: () => ({
        onmessage: null,
        onerror: null,
        postMessage: vi.fn(),
        terminate: vi.fn(),
      }),
    });
    void controller.startSend(new File(["payload"], "payload.txt"));

    try {
      openNewGeneration();
      await vi.waitFor(() =>
        expect(sent).toContainEqual(
          expect.objectContaining({ t: "manifest", mode: "single" }),
        ),
      );
    } finally {
      controller.destroy();
    }
  });

  it("sends a file manifest when channels are already open", async () => {
    const { peer, sent } = createChannelReadinessPeer();
    peer.ctrl.readyState = "open";
    peer.data.readyState = "open";
    const controller = createTransferController("uploader", peer as never);

    await controller.startSend(new File(["payload"], "payload.txt"));

    expect(sent).toContainEqual(
      expect.objectContaining({ t: "manifest", mode: "single" }),
    );
    controller.destroy();
  });

  it("sends a folder manifest after a channel generation swap", async () => {
    const { openNewGeneration, peer, sent } = createChannelReadinessPeer();
    const controller = createTransferController("uploader", peer as never);
    void controller.startFolderSend(
      [{ path: "root/file.txt", file: new File(["payload"], "file.txt") }],
      "root",
    );

    try {
      openNewGeneration();
      await vi.waitFor(() =>
        expect(sent).toContainEqual(
          expect.objectContaining({ t: "manifest", mode: "zip" }),
        ),
      );
    } finally {
      controller.destroy();
    }
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

  it("waits for explicit acceptance before requesting the manifest", async () => {
    const ctrlHandlers = new Map<string, (message: unknown) => void>();
    const sent: unknown[] = [];
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
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const ctrl = {
      readyState: "open",
      send: (message: unknown) => sent.push(message),
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
    const sinkFactory = vi.fn(() => ({
      strategy: "null" as const,
      write: vi.fn(),
      close: vi.fn(),
      cancel: vi.fn(),
    }));
    const onManifest = vi.fn();
    const controller = createTransferController("downloader", peer as never, {
      onManifest,
      receiverWorkerFactory: () => worker,
      sinkFactory,
    });
    const manifest = {
      t: "manifest" as const,
      transferId: "transfer-1",
      mode: "single" as const,
      items: [{ path: "file.bin", size: 1, lastModified: 0 }],
      totalBytes: 1,
      suggestedName: "file.bin",
    };

    ctrlHandlers.get("manifest")?.(manifest);
    expect(onManifest).toHaveBeenCalledWith(manifest);
    expect(sent).toEqual([]);
    controller.acceptTransfer();
    expect(sinkFactory).toHaveBeenCalledWith("file.bin", 1);
    expect(sent).toEqual([]);
    await Promise.resolve();
    expect(sent).toContainEqual({
      t: "request",
      transferId: "transfer-1",
      offset: 0,
    });
    controller.destroy();
  });

  it("waits for final worker chunks before closing the sink", async () => {
    const ctrlHandlers = new Map<string, (message: unknown) => void>();
    const sent: unknown[] = [];
    let dataMessage: ((event: MessageEvent<unknown>) => void) | undefined;
    const sinkClose = vi.fn();
    const sinkWrite = vi.fn();
    const sinkCancel = vi.fn();
    const worker = {
      onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
      onerror: null as ((event: ErrorEvent) => void) | null,
      postMessage: vi.fn(),
      terminate: vi.fn(),
    };
    const data = {
      readyState: "open",
      bufferedAmount: 0,
      send: vi.fn(),
      addEventListener: vi.fn((type: string, listener: unknown) => {
        if (type === "message") {
          dataMessage = listener as (event: MessageEvent<unknown>) => void;
        }
      }),
      removeEventListener: vi.fn(),
    };
    const ctrl = {
      readyState: "open",
      send: (message: unknown) => sent.push(message),
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
    const controller = createTransferController("downloader", peer as never, {
      receiverWorkerFactory: () => worker,
      sinkFactory: () => ({
        strategy: "null" as const,
        write: sinkWrite,
        close: sinkClose,
        cancel: sinkCancel,
      }),
    });
    const manifest = {
      t: "manifest" as const,
      transferId: "transfer-final-slice",
      mode: "single" as const,
      items: [{ path: "file.bin", size: 8, lastModified: 0 }],
      totalBytes: 8,
      suggestedName: "file.bin",
    };

    ctrlHandlers.get("manifest")?.(manifest);
    controller.acceptTransfer();
    await Promise.resolve();
    ctrlHandlers.get("start")?.({
      t: "start",
      transferId: manifest.transferId,
      offset: 0,
    });
    ctrlHandlers.get("done")?.({
      t: "done",
      transferId: manifest.transferId,
      sha256: "hash",
    });
    dataMessage?.({ data: new ArrayBuffer(8) } as MessageEvent<unknown>);

    expect(sinkClose).not.toHaveBeenCalled();

    const emitChunk = (chunkId: string): void => {
      worker.onmessage?.({
        data: {
          t: "chunk",
          chunkId,
          buffer: new ArrayBuffer(4),
          bytesDone: chunkId === "0" ? 4 : 8,
          totalBytes: 8,
        },
      } as MessageEvent<unknown>);
    };
    emitChunk("0");
    expect(sinkClose).not.toHaveBeenCalled();
    emitChunk("1");
    await vi.waitFor(() => expect(sinkClose).toHaveBeenCalledOnce());

    expect(worker.postMessage).toHaveBeenCalledWith({ t: "finish" });
    expect(sent).not.toContainEqual(expect.objectContaining({ t: "error" }));
    controller.destroy();
  });

  it("counts bytes when the sink detaches received chunk buffers", async () => {
    const ctrlHandlers = new Map<string, (message: unknown) => void>();
    let dataMessage: ((event: MessageEvent<unknown>) => void) | undefined;
    const onError = vi.fn();
    const onResult = vi.fn();
    const worker = {
      onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
      onerror: null as ((event: ErrorEvent) => void) | null,
      postMessage: vi.fn(),
      terminate: vi.fn(),
    };
    const data = {
      readyState: "open",
      bufferedAmount: 0,
      send: vi.fn(),
      addEventListener: vi.fn((type: string, listener: unknown) => {
        if (type === "message") {
          dataMessage = listener as (event: MessageEvent<unknown>) => void;
        }
      }),
      removeEventListener: vi.fn(),
    };
    const ctrl = {
      readyState: "open",
      send: vi.fn(),
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
    const controller = createTransferController("downloader", peer as never, {
      onError,
      onResult,
      receiverWorkerFactory: () => worker,
      sinkFactory: () => ({
        strategy: "null" as const,
        write: async (bytes: Uint8Array) => {
          structuredClone(bytes.buffer, { transfer: [bytes.buffer] });
        },
        close: vi.fn(),
        cancel: vi.fn(),
      }),
    });
    const manifest = {
      t: "manifest" as const,
      transferId: "transfer-detached-chunk",
      mode: "single" as const,
      items: [{ path: "file.bin", size: 4, lastModified: 0 }],
      totalBytes: 4,
      suggestedName: "file.bin",
    };

    ctrlHandlers.get("manifest")?.(manifest);
    controller.acceptTransfer();
    await Promise.resolve();
    ctrlHandlers.get("start")?.({
      t: "start",
      transferId: manifest.transferId,
      offset: 0,
    });
    ctrlHandlers.get("done")?.({
      t: "done",
      transferId: manifest.transferId,
      sha256: "hash",
    });
    dataMessage?.({ data: new ArrayBuffer(4) } as MessageEvent<unknown>);
    worker.onmessage?.({
      data: {
        t: "chunk",
        chunkId: "0",
        buffer: new ArrayBuffer(4),
        bytesDone: 4,
        totalBytes: 4,
      },
    } as MessageEvent<unknown>);

    await vi.waitFor(() =>
      expect(worker.postMessage).toHaveBeenCalledWith({
        t: "commit",
        chunkId: "0",
      }),
    );
    await vi.waitFor(() =>
      expect(worker.postMessage).toHaveBeenCalledWith({ t: "finish" }),
    );
    worker.onmessage?.({
      data: { t: "done", bytesDone: 4, sha256: "hash" },
    } as MessageEvent<unknown>);

    await vi.waitFor(() => expect(onResult).toHaveBeenCalledOnce());
    expect(onResult).toHaveBeenCalledWith(
      expect.objectContaining({ verified: true }),
    );
    expect(onError).not.toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining(
          "The receiver worker finished before the sink was drained.",
        ),
      }),
    );
    controller.destroy();
  });

  it("waits for in-flight sink commits before accepting worker done", async () => {
    const ctrlHandlers = new Map<string, (message: unknown) => void>();
    let dataMessage: ((event: MessageEvent<unknown>) => void) | undefined;
    let resolveWrite: (() => void) | undefined;
    const onResult = vi.fn();
    const worker = {
      onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
      onerror: null as ((event: ErrorEvent) => void) | null,
      postMessage: vi.fn(),
      terminate: vi.fn(),
    };
    const data = {
      readyState: "open",
      bufferedAmount: 0,
      send: vi.fn(),
      addEventListener: vi.fn((type: string, listener: unknown) => {
        if (type === "message") {
          dataMessage = listener as (event: MessageEvent<unknown>) => void;
        }
      }),
      removeEventListener: vi.fn(),
    };
    const ctrl = {
      readyState: "open",
      send: vi.fn(),
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
    const controller = createTransferController("downloader", peer as never, {
      onResult,
      receiverWorkerFactory: () => worker,
      sinkFactory: () => ({
        strategy: "null" as const,
        write: () =>
          new Promise<void>((resolve) => {
            resolveWrite = resolve;
          }),
        close: vi.fn(),
        cancel: vi.fn(),
      }),
    });
    const manifest = {
      t: "manifest" as const,
      transferId: "transfer-in-flight-commit",
      mode: "single" as const,
      items: [{ path: "file.bin", size: 4, lastModified: 0 }],
      totalBytes: 4,
      suggestedName: "file.bin",
    };

    ctrlHandlers.get("manifest")?.(manifest);
    controller.acceptTransfer();
    await Promise.resolve();
    ctrlHandlers.get("start")?.({
      t: "start",
      transferId: manifest.transferId,
      offset: 0,
    });
    ctrlHandlers.get("done")?.({
      t: "done",
      transferId: manifest.transferId,
      sha256: "hash",
    });
    dataMessage?.({ data: new ArrayBuffer(4) } as MessageEvent<unknown>);
    worker.onmessage?.({
      data: {
        t: "chunk",
        chunkId: "0",
        buffer: new ArrayBuffer(4),
        bytesDone: 4,
        totalBytes: 4,
      },
    } as MessageEvent<unknown>);
    worker.onmessage?.({
      data: { t: "done", bytesDone: 4, sha256: "hash" },
    } as MessageEvent<unknown>);

    expect(onResult).not.toHaveBeenCalled();
    resolveWrite?.();
    await vi.waitFor(() => expect(onResult).toHaveBeenCalledOnce());
    expect(onResult).toHaveBeenCalledWith(
      expect.objectContaining({ verified: true }),
    );
    controller.destroy();
  });

  it("fails when the sink remains genuinely short", async () => {
    const ctrlHandlers = new Map<string, (message: unknown) => void>();
    const onError = vi.fn();
    const worker = {
      onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
      onerror: null as ((event: ErrorEvent) => void) | null,
      postMessage: vi.fn(),
      terminate: vi.fn(),
    };
    const peer = {
      ctrl: { readyState: "open", send: vi.fn() },
      data: {
        readyState: "open",
        bufferedAmount: 0,
        send: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
      maxMessageSize: undefined,
      on: () => () => false,
      onCtrl: (type: string, handler: (message: unknown) => void) => {
        ctrlHandlers.set(type, handler);
        return () => ctrlHandlers.delete(type);
      },
    };
    const controller = createTransferController("downloader", peer as never, {
      onError,
      receiverWorkerFactory: () => worker,
      sinkFactory: () => ({
        strategy: "null" as const,
        write: vi.fn(async () => undefined),
        close: vi.fn(),
        cancel: vi.fn(),
      }),
    });
    const manifest = {
      t: "manifest" as const,
      transferId: "transfer-short-sink",
      mode: "single" as const,
      items: [{ path: "file.bin", size: 8, lastModified: 0 }],
      totalBytes: 8,
      suggestedName: "file.bin",
    };

    ctrlHandlers.get("manifest")?.(manifest);
    controller.acceptTransfer();
    await Promise.resolve();

    const internals = controller as unknown as {
      receiverFinishRequested: boolean;
      receiverStarted: boolean;
      receiverCommittedBytes: number;
    };
    internals.receiverFinishRequested = true;
    internals.receiverStarted = true;
    internals.receiverCommittedBytes = 4;
    worker.onmessage?.({
      data: { t: "done", bytesDone: 4, sha256: "short-hash" },
    } as MessageEvent<unknown>);

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining(
          "The receiver worker finished before the sink was drained.",
        ),
      }),
    );
    controller.destroy();
  });

  it("does not report a cancelled final write after a primary worker failure", async () => {
    const ctrlHandlers = new Map<string, (message: unknown) => void>();
    const sent: unknown[] = [];
    let dataMessage: ((event: MessageEvent<unknown>) => void) | undefined;
    let rejectWrite: ((reason: unknown) => void) | undefined;
    const onError = vi.fn();
    const worker = {
      onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
      onerror: null as ((event: ErrorEvent) => void) | null,
      postMessage: vi.fn(),
      terminate: vi.fn(),
    };
    const data = {
      readyState: "open",
      bufferedAmount: 0,
      send: vi.fn(),
      addEventListener: vi.fn((type: string, listener: unknown) => {
        if (type === "message") {
          dataMessage = listener as (event: MessageEvent<unknown>) => void;
        }
      }),
      removeEventListener: vi.fn(),
    };
    const ctrl = {
      readyState: "open",
      send: (message: unknown) => sent.push(message),
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
    const controller = createTransferController("downloader", peer as never, {
      onError,
      receiverWorkerFactory: () => worker,
      sinkFactory: () => ({
        strategy: "null" as const,
        write: () =>
          new Promise<void>((_, reject) => {
            rejectWrite = reject;
          }),
        close: vi.fn(),
        cancel: vi.fn(),
      }),
    });
    const manifest = {
      t: "manifest" as const,
      transferId: "transfer-failed-final-slice",
      mode: "single" as const,
      items: [{ path: "file.bin", size: 4, lastModified: 0 }],
      totalBytes: 4,
      suggestedName: "file.bin",
    };

    ctrlHandlers.get("manifest")?.(manifest);
    controller.acceptTransfer();
    await Promise.resolve();
    dataMessage?.({ data: new ArrayBuffer(4) } as MessageEvent<unknown>);
    worker.onmessage?.({
      data: {
        t: "chunk",
        chunkId: "0",
        buffer: new ArrayBuffer(4),
        bytesDone: 4,
        totalBytes: 4,
      },
    } as MessageEvent<unknown>);

    worker.onerror?.({
      message: "primary receiver failure",
      filename: "receiver.worker.ts",
      lineno: 10,
      colno: 2,
    } as ErrorEvent);
    rejectWrite?.(new Error("The download sink is not accepting data."));
    await Promise.resolve();
    await Promise.resolve();

    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "primary receiver failure" }),
    );
    expect(sent).toContainEqual(
      expect.objectContaining({
        t: "error",
        message: "primary receiver failure",
      }),
    );
    expect(sent).not.toContainEqual(
      expect.objectContaining({
        t: "error",
        message: "The download sink is not accepting data.",
      }),
    );
    controller.destroy();
  });

  it("accepts a non-zero request and re-seeds the existing sender worker", async () => {
    const ctrlHandlers = new Map<string, (message: unknown) => void>();
    const sent: unknown[] = [];
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
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const ctrl = {
      readyState: "open",
      send: (message: unknown) => sent.push(message),
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
    const transferId = (sent[0] as { transferId: string }).transferId;

    ctrlHandlers.get("request")?.({
      t: "request",
      transferId,
      offset: 0,
    });
    ctrlHandlers.get("request")?.({
      t: "request",
      transferId,
      offset: 4,
    });

    expect(sent).toContainEqual({ t: "start", transferId, offset: 4 });
    expect(worker.postMessage).toHaveBeenLastCalledWith({
      t: "resume",
      offset: 4,
    });
    controller.destroy();
  });

  it("accepts a consistent ZIP manifest", () => {
    const ctrlHandlers = new Map<string, (message: unknown) => void>();
    const onManifest = vi.fn();
    const worker = {
      onmessage: null,
      onerror: null,
      postMessage: vi.fn(),
      terminate: vi.fn(),
    };
    const peer = {
      ctrl: { readyState: "open", send: vi.fn() },
      data: {
        readyState: "open",
        bufferedAmount: 0,
        send: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
      maxMessageSize: undefined,
      on: () => () => false,
      onCtrl: (type: string, handler: (message: unknown) => void) => {
        ctrlHandlers.set(type, handler);
        return () => ctrlHandlers.delete(type);
      },
    };
    const controller = createTransferController("downloader", peer as never, {
      onManifest,
      receiverWorkerFactory: () => worker,
    });

    ctrlHandlers.get("manifest")?.({
      t: "manifest",
      transferId: "zip-transfer",
      mode: "zip",
      items: [
        { path: "root/a.txt", size: 3, lastModified: 1 },
        { path: "root/empty/", size: 0, lastModified: 0 },
      ],
      totalBytes: 128,
      suggestedName: "root.zip",
    });

    expect(onManifest).toHaveBeenCalledOnce();
    expect(worker.postMessage).toHaveBeenCalledWith({
      t: "init",
      transferId: "zip-transfer",
      offset: 0,
      totalBytes: 128,
    });
    controller.destroy();
  });

  it("uses the shared ZIP prediction for the folder manifest total", async () => {
    const sent: unknown[] = [];
    const ctrlHandlers = new Map<string, (message: unknown) => void>();
    const peer = {
      ctrl: {
        readyState: "open",
        send: (message: unknown) => sent.push(message),
      },
      data: {
        readyState: "open",
        bufferedAmount: 0,
        send: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
      maxMessageSize: undefined,
      on: () => () => false,
      onCtrl: (type: string, handler: (message: unknown) => void) => {
        ctrlHandlers.set(type, handler);
        return () => ctrlHandlers.delete(type);
      },
    };
    const controller = createTransferController("uploader", peer as never);
    const entries = [
      { path: "root/", file: undefined },
      { path: "root/empty/", file: undefined },
      { path: "root/file.txt", file: new File(["payload"], "file.txt") },
    ];

    await controller.startFolderSend(entries, "root");

    const manifest = sent[0] as {
      mode: string;
      totalBytes: number;
      items: Array<{ path: string; size: number }>;
      suggestedName: string;
    };
    expect(manifest.mode).toBe("zip");
    expect(manifest.suggestedName).toBe("root.zip");
    expect(manifest.items).toEqual([
      { path: "root/file.txt", size: 7, lastModified: expect.any(Number) },
    ]);
    expect(manifest.totalBytes).toBe(
      Number(predictLength(makeZipPlan(entries))),
    );
    controller.destroy();
  });

  it.each([
    { totalBytes: 0, items: [] },
    { totalBytes: 4, items: [{ path: "a", size: 5, lastModified: 1 }] },
    { totalBytes: 4, items: [{ path: "a", size: -1, lastModified: 1 }] },
  ])("rejects an inconsistent ZIP manifest", ({ totalBytes, items }) => {
    const ctrlHandlers = new Map<string, (message: unknown) => void>();
    const onError = vi.fn();
    const peer = {
      ctrl: { readyState: "open", send: vi.fn() },
      data: {
        readyState: "open",
        bufferedAmount: 0,
        send: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      },
      maxMessageSize: undefined,
      on: () => () => false,
      onCtrl: (type: string, handler: (message: unknown) => void) => {
        ctrlHandlers.set(type, handler);
        return () => ctrlHandlers.delete(type);
      },
    };
    const controller = createTransferController("downloader", peer as never, {
      onError,
    });

    ctrlHandlers.get("manifest")?.({
      t: "manifest",
      transferId: "bad-zip-transfer",
      mode: "zip",
      items,
      totalBytes,
      suggestedName: "root.zip",
    });

    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringMatching(/ZIP manifest/),
      }),
    );
    controller.destroy();
  });
});

describe("receiver sink stall watchdog", () => {
  it("restarts a stalled service-worker sink once with the blob sink", async () => {
    vi.useFakeTimers();
    const ctrlHandlers = new Map<string, (message: unknown) => void>();
    const sent: unknown[] = [];
    const workers: Array<{
      onmessage: ((event: MessageEvent<unknown>) => void) | null;
      onerror: ((event: ErrorEvent) => void) | null;
      postMessage: ReturnType<typeof vi.fn>;
      terminate: ReturnType<typeof vi.fn>;
    }> = [];
    const receiverWorkerFactory = vi.fn(() => {
      const worker = {
        onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
        onerror: null as ((event: ErrorEvent) => void) | null,
        postMessage: vi.fn(),
        terminate: vi.fn(),
      };
      workers.push(worker);
      return worker;
    });
    const data = {
      readyState: "open",
      bufferedAmount: 0,
      send: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    const peer = {
      ctrl: {
        readyState: "open",
        send: (message: unknown) => sent.push(message),
      },
      data,
      maxMessageSize: undefined,
      on: () => () => false,
      onCtrl: (type: string, handler: (message: unknown) => void) => {
        ctrlHandlers.set(type, handler);
        return () => ctrlHandlers.delete(type);
      },
    };
    const swCancel = vi.fn();
    let writtenBytes = 0;
    const sinkFactory = vi.fn(() => ({
      strategy: "sw" as const,
      write: (bytes: Uint8Array) => {
        if (writtenBytes >= 4) {
          return new Promise<void>(() => {});
        }
        writtenBytes += bytes.byteLength;
        return Promise.resolve();
      },
      close: vi.fn(),
      cancel: swCancel,
    }));
    const onResumeRequested = vi.fn();
    const onSinkStall = vi.fn();
    const controller = createTransferController("downloader", peer as never, {
      onResumeRequested,
      onSinkStall,
      receiverWorkerFactory,
      sinkFactory,
    });
    const manifest = {
      t: "manifest" as const,
      transferId: "transfer-sw-fallback",
      mode: "single" as const,
      items: [{ path: "file.bin", size: 8, lastModified: 0 }],
      totalBytes: 8,
      suggestedName: "file.bin",
    };

    ctrlHandlers.get("manifest")?.(manifest);
    controller.acceptTransfer();
    await Promise.resolve();
    expect(sinkFactory).toHaveBeenCalledWith("file.bin", 8);
    expect(sent).toContainEqual({
      t: "request",
      transferId: manifest.transferId,
      offset: 0,
    });

    const firstWorker = workers[0];
    if (firstWorker === undefined) {
      throw new Error("The receiver worker was not created.");
    }
    ctrlHandlers.get("start")?.({
      t: "start",
      transferId: manifest.transferId,
      offset: 0,
    });
    ctrlHandlers.get("done")?.({
      t: "done",
      transferId: manifest.transferId,
      sha256: "hash",
    });
    const emitChunk = (
      worker: (typeof workers)[number],
      chunkId: string,
      byteLength: number,
    ): void => {
      worker.onmessage?.({
        data: {
          t: "chunk",
          chunkId,
          buffer: new ArrayBuffer(byteLength),
          bytesDone: byteLength,
          totalBytes: 8,
        },
      } as MessageEvent<unknown>);
    };
    emitChunk(firstWorker, "0", 4);
    await Promise.resolve();
    emitChunk(firstWorker, "1", 1);

    await vi.advanceTimersByTimeAsync(SINK_SW_NO_CONSUMER_STALL_MS);

    expect(swCancel).toHaveBeenCalledWith(
      "Restarting the download with a browser fallback.",
    );
    expect(firstWorker.terminate).toHaveBeenCalledOnce();
    expect(receiverWorkerFactory).toHaveBeenCalledTimes(2);
    expect(sinkFactory).toHaveBeenCalledTimes(1);
    expect(
      sent.filter((message) => (message as { t?: string }).t === "request"),
    ).toEqual([
      { t: "request", transferId: manifest.transferId, offset: 0 },
      { t: "request", transferId: manifest.transferId, offset: 0 },
    ]);
    expect(onResumeRequested).toHaveBeenCalledOnce();
    expect(onSinkStall).toHaveBeenCalledWith(
      expect.objectContaining({
        stalled: true,
        reason: "sw-no-consumer",
      }),
    );

    await vi.advanceTimersByTimeAsync(SINK_SW_NO_CONSUMER_STALL_MS);
    expect(
      sent.filter((message) => (message as { t?: string }).t === "request"),
    ).toHaveLength(2);
    controller.destroy();
  });

  it("does not fail a finishing transfer while the sink is stalled", async () => {
    vi.useFakeTimers();
    const harness = await createReceiverStallHarness();
    const watchdogError =
      "The receiver sink stopped making progress while the transfer was finishing.";

    await vi.advanceTimersByTimeAsync(SINK_STALL_NOTICE_MS);
    harness.emitWorkerDone();
    await vi.advanceTimersByTimeAsync(SINK_PROGRESS_WATCHDOG_MS + 1);

    expect(harness.onError).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: watchdogError }),
    );
    harness.controller.destroy();
  });

  it("re-arms the finishing watchdog after the sink recovers", async () => {
    vi.useFakeTimers();
    const harness = await createReceiverStallHarness();
    const watchdogError =
      "The receiver sink stopped making progress while the transfer was finishing.";

    await vi.advanceTimersByTimeAsync(SINK_STALL_NOTICE_MS);
    harness.emitWorkerDone();
    await vi.advanceTimersByTimeAsync(SINK_PROGRESS_WATCHDOG_MS + 1);
    expect(harness.onError).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: watchdogError }),
    );

    harness.resolveWrite?.();
    await Promise.resolve();
    expect(harness.onSinkStall).toHaveBeenCalledWith({
      stalled: true,
      sinceMs: expect.any(Number),
    });
    expect(harness.onSinkStall).toHaveBeenCalledWith({
      stalled: false,
      sinceMs: expect.any(Number),
    });

    vi.advanceTimersByTime(SINK_PROGRESS_WATCHDOG_MS);
    expect(harness.onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: watchdogError }),
    );
    harness.controller.destroy();
  });
});
