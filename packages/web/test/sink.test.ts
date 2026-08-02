import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BLOB_MAX_BYTES,
  BLOB_MAX_BYTES_IOS,
  blobMaxBytes,
  consumeSwCredit,
  createBlobSink,
  createSwCreditState,
  detectSinkStrategy,
  isNextSwSequence,
  releaseSwCredit,
  SINK_PROGRESS_WATCHDOG_MS,
  SINK_STALL_ABORT_MS,
  SINK_STALL_NOTICE_MS,
  SINK_START_TIMEOUT_MS,
  type Sink,
  SinkManager,
  SwStreamSink,
} from "../src/sink";
import { createSwSink } from "../src/sink/swStream";
import type { ReceiverWorkerEvent } from "../src/worker/messages";
import { ReceiverProcessor } from "../src/worker/receiverLogic";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("sink strategy detection", () => {
  it("prefers FSA, then service-worker streaming, then blob", () => {
    expect(
      detectSinkStrategy({
        showSaveFilePicker: () => undefined,
        serviceWorker: {},
      }),
    ).toBe("fsa");
    expect(detectSinkStrategy({ serviceWorker: {} })).toBe("sw");
    expect(detectSinkStrategy({})).toBe("blob");
  });

  it("allows exactly 500 MiB and refuses larger blob downloads", () => {
    expect(() => createBlobSink("allowed.bin", BLOB_MAX_BYTES)).not.toThrow();
    expect(() => createBlobSink("too-large.bin", BLOB_MAX_BYTES + 1)).toThrow(
      /too large/i,
    );
  });
});

describe("blob sink limits", () => {
  it("selects the platform-specific blob ceiling", () => {
    const iphoneUserAgent =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

    expect(blobMaxBytes({ userAgent: iphoneUserAgent })).toBe(
      BLOB_MAX_BYTES_IOS,
    );
    expect(blobMaxBytes({ platform: "MacIntel", maxTouchPoints: 5 })).toBe(
      BLOB_MAX_BYTES_IOS,
    );
    expect(blobMaxBytes({ platform: "MacIntel", maxTouchPoints: 0 })).toBe(
      BLOB_MAX_BYTES,
    );
    expect(blobMaxBytes({})).toBe(BLOB_MAX_BYTES);
  });

  it("enforces the iOS blob ceiling", () => {
    const iphoneUserAgent =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
    vi.stubGlobal("navigator", {
      userAgent: iphoneUserAgent,
      platform: "iPhone",
    });

    expect(() => createBlobSink("ok.bin", BLOB_MAX_BYTES_IOS)).not.toThrow();
    expect(() =>
      createBlobSink("too-large.bin", BLOB_MAX_BYTES_IOS + 1),
    ).toThrow(/too large/i);

    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
      platform: "Linux x86_64",
    });
    expect(() =>
      createBlobSink("desktop-ok.bin", BLOB_MAX_BYTES_IOS + 1),
    ).not.toThrow();
  });

  it("releases the blob parts after close", () => {
    let capturedParts: BlobPart[] | undefined;
    let capturedPartCount = 0;
    class FakeBlob {
      constructor(parts: BlobPart[]) {
        capturedParts = parts;
        capturedPartCount = parts.length;
      }
    }
    vi.stubGlobal("Blob", FakeBlob);
    vi.stubGlobal("URL", {
      createObjectURL: () => "blob:fake",
      revokeObjectURL: vi.fn(),
    });
    vi.stubGlobal("window", { setTimeout });
    vi.stubGlobal("document", {
      body: { append: vi.fn() },
      createElement: () => ({ click: vi.fn(), remove: vi.fn() }),
    });

    const sink = createBlobSink("file.bin", 2);
    sink.write(new Uint8Array([1]));
    sink.write(new Uint8Array([2]));
    sink.close();

    if (capturedParts === undefined) {
      throw new Error("The Blob constructor was not called.");
    }
    expect(capturedPartCount).toBe(2);
    expect(capturedParts.length).toBe(0);
  });
});

describe("receiver sink commit protocol", () => {
  it("withholds the interval ack until the sink commits the chunk", () => {
    const events: ReceiverWorkerEvent[] = [];
    const processor = new ReceiverProcessor((message) => {
      events.push(message);
    });
    const bytes = new Uint8Array(4 * 1024 * 1024);
    processor.handle({
      t: "init",
      transferId: "transfer-1",
      offset: 0,
      totalBytes: bytes.byteLength,
    });
    processor.handle({ t: "data", buffer: bytes.buffer });

    expect(events.some((event) => event.t === "ack")).toBe(false);
    const chunk = events.find((event) => event.t === "chunk");
    expect(chunk?.chunkId).toBe("0");

    processor.handle({ t: "commit", chunkId: chunk?.chunkId ?? "" });
    expect(events).toContainEqual({ t: "ack", receivedBytes: 4 * 1024 * 1024 });
  });

  it("turns a sink error into a worker error event", () => {
    const events: ReceiverWorkerEvent[] = [];
    const processor = new ReceiverProcessor((message) => {
      events.push(message);
    });
    processor.handle({
      t: "init",
      transferId: "transfer-1",
      offset: 0,
      totalBytes: 1,
    });
    processor.handle({ t: "sink-error", message: "Disk full." });

    expect(events).toContainEqual({ t: "error", message: "Disk full." });
  });
});

describe("bounded sink manager", () => {
  it("fails a write that never starts after the start timeout", async () => {
    vi.useFakeTimers();
    const sink = {
      strategy: "null" as const,
      write: () => new Promise<void>(() => {}),
      close: vi.fn(),
      cancel: vi.fn(),
    };
    const stalls: Array<{ stalled: boolean; sinceMs: number } | undefined> = [];
    const manager = new SinkManager(sink, {
      onStallChange: (stall) => stalls.push(stall),
    });
    const write = manager.write(new Uint8Array([1]));

    await vi.advanceTimersByTimeAsync(SINK_STALL_NOTICE_MS);
    expect(stalls[0]?.stalled).toBe(true);

    const rejection = expect(write).rejects.toThrow(
      "The download never started — your browser did not begin saving the file. Check for a blocked or dismissed download prompt, then try again.",
    );
    await vi.advanceTimersByTimeAsync(
      SINK_START_TIMEOUT_MS - SINK_STALL_NOTICE_MS,
    );
    await rejection;
  });

  it("uses the long stall timeout after a write completes", async () => {
    vi.useFakeTimers();
    let writeCount = 0;
    const sink = {
      strategy: "null" as const,
      write: () => {
        writeCount += 1;
        return writeCount === 1
          ? Promise.resolve()
          : new Promise<void>(() => {});
      },
      close: vi.fn(),
      cancel: vi.fn(),
      isResponsive: () => true,
    };
    const manager = new SinkManager(sink);

    await expect(manager.write(new Uint8Array([1]))).resolves.toBeUndefined();
    const write = manager.write(new Uint8Array([2]));
    let settled = false;
    void write.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await vi.advanceTimersByTimeAsync(SINK_START_TIMEOUT_MS);
    await Promise.resolve();
    expect(settled).toBe(false);

    const rejection = expect(write).rejects.toThrow(
      "The download has been paused for too long. Your browser stopped accepting data.",
    );
    await vi.advanceTimersByTimeAsync(
      SINK_STALL_ABORT_MS - SINK_START_TIMEOUT_MS,
    );
    await rejection;
  });

  it("calls cancel while a write is still pending", async () => {
    let resolveWrite: (() => void) | undefined;
    const cancel = vi.fn();
    const sink = {
      strategy: "null" as const,
      write: () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        }),
      close: vi.fn(),
      cancel,
    };
    const manager = new SinkManager(sink);
    const write = manager.write(new Uint8Array([1]));
    manager.cancel("User cancelled.");

    expect(cancel).toHaveBeenCalledWith("User cancelled.");
    await expect(write).rejects.toThrow("User cancelled.");
    resolveWrite?.();
  });

  it("reports a stalled write without rejecting or poisoning the manager", async () => {
    vi.useFakeTimers();
    let resolveFirstWrite: (() => void) | undefined;
    let writeCount = 0;
    const sink = {
      strategy: "null" as const,
      write: () => {
        writeCount += 1;
        return writeCount === 1
          ? new Promise<void>((resolve) => {
              resolveFirstWrite = resolve;
            })
          : Promise.resolve();
      },
      close: vi.fn(),
      cancel: vi.fn(),
    };
    const stalls: Array<{ stalled: boolean; sinceMs: number } | undefined> = [];
    const manager = new SinkManager(sink, {
      onStallChange: (stall) => stalls.push(stall),
    });
    const write = manager.write(new Uint8Array([1]));

    await vi.advanceTimersByTimeAsync(SINK_STALL_NOTICE_MS);
    expect(stalls[0]?.stalled).toBe(true);
    let settled = false;
    void write.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveFirstWrite?.();
    await expect(write).resolves.toBeUndefined();
    expect(stalls[1]?.stalled).toBe(false);

    await expect(manager.write(new Uint8Array([2]))).resolves.toBeUndefined();
  });

  it("fails a stalled write at the ceiling with the responsive message", async () => {
    vi.useFakeTimers();
    let writeCount = 0;
    const sink = {
      strategy: "null" as const,
      write: () => {
        writeCount += 1;
        return writeCount === 1
          ? Promise.resolve()
          : new Promise<void>(() => {});
      },
      close: vi.fn(),
      cancel: vi.fn(),
      isResponsive: () => true,
    };
    const manager = new SinkManager(sink);
    await expect(manager.write(new Uint8Array([1]))).resolves.toBeUndefined();
    const write = manager.write(new Uint8Array([2]));

    await vi.advanceTimersByTimeAsync(SINK_STALL_NOTICE_MS);
    const rejection = expect(write).rejects.toThrow(
      "The download has been paused for too long. Your browser stopped accepting data.",
    );
    await vi.advanceTimersByTimeAsync(
      SINK_STALL_ABORT_MS - SINK_STALL_NOTICE_MS,
    );
    await rejection;
  });

  it("fails a stalled write at the ceiling with the unresponsive message", async () => {
    vi.useFakeTimers();
    let writeCount = 0;
    const sink = {
      strategy: "null" as const,
      write: () => {
        writeCount += 1;
        return writeCount === 1
          ? Promise.resolve()
          : new Promise<void>(() => {});
      },
      close: vi.fn(),
      cancel: vi.fn(),
      isResponsive: () => false,
    };
    const manager = new SinkManager(sink);
    await expect(manager.write(new Uint8Array([1]))).resolves.toBeUndefined();
    const write = manager.write(new Uint8Array([2]));

    await vi.advanceTimersByTimeAsync(SINK_STALL_NOTICE_MS);
    const rejection = expect(write).rejects.toThrow(
      "The download service worker stopped responding.",
    );
    await vi.advanceTimersByTimeAsync(
      SINK_STALL_ABORT_MS - SINK_STALL_NOTICE_MS,
    );
    await rejection;
  });

  it("treats a sink without liveness as unknown at the ceiling", async () => {
    vi.useFakeTimers();
    let writeCount = 0;
    const sink = {
      strategy: "null" as const,
      write: () => {
        writeCount += 1;
        return writeCount === 1
          ? Promise.resolve()
          : new Promise<void>(() => {});
      },
      close: vi.fn(),
      cancel: vi.fn(),
    };
    const manager = new SinkManager(sink);
    await expect(manager.write(new Uint8Array([1]))).resolves.toBeUndefined();
    const write = manager.write(new Uint8Array([2]));

    await vi.advanceTimersByTimeAsync(SINK_STALL_NOTICE_MS);
    const rejection = expect(write).rejects.toThrow(
      "The download has been paused for too long. Your browser stopped accepting data.",
    );
    await vi.advanceTimersByTimeAsync(
      SINK_STALL_ABORT_MS - SINK_STALL_NOTICE_MS,
    );
    await rejection;
  });
});

describe("service-worker credit protocol", () => {
  it("consumes and returns credits in byte order", () => {
    const state = createSwCreditState(8);
    expect(consumeSwCredit(state, 5)).toBe(true);
    expect(consumeSwCredit(state, 4)).toBe(false);
    releaseSwCredit(state, 5);
    expect(state.availableBytes).toBe(8);
    expect(isNextSwSequence(0, 0)).toBe(true);
    expect(isNextSwSequence(1, 0)).toBe(false);
  });
});

interface SwSinkHarness {
  sink: SwStreamSink;
  sendMessage: (message: unknown) => void;
}

interface PendingSwSinkHarness {
  active: { postMessage: ReturnType<typeof vi.fn> };
  append: ReturnType<typeof vi.fn>;
  sendMessage: (message: unknown) => void;
  start: Promise<Sink>;
}

const SW_STARTED_TIMEOUT_MS = 10_000;

const createPendingSwSinkHarness = (
  controller: object | null,
): PendingSwSinkHarness => {
  const listeners = new Map<string, (event: MessageEvent) => void>();
  const active = { postMessage: vi.fn() };
  const serviceWorker = {
    addEventListener: (type: string, listener: (event: MessageEvent) => void) =>
      listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
    register: vi.fn(async () => ({ active })),
    controller,
  };
  const append = vi.fn();
  vi.stubGlobal("navigator", { serviceWorker });
  vi.stubGlobal("window", {
    clearInterval,
    clearTimeout,
    setInterval,
    setTimeout,
  });
  vi.stubGlobal("document", {
    body: { append },
    createElement: () => ({ remove: vi.fn() }),
  });
  const start = createSwSink("file.bin", 2);
  return {
    active,
    append,
    sendMessage: (message) => {
      const firstCall = active.postMessage.mock.calls[0];
      if (firstCall === undefined) {
        throw new Error("The sink did not send its init message.");
      }
      const id = (firstCall[0] as { id: string }).id;
      listeners.get("message")?.({
        data: { ...message, id },
      } as MessageEvent);
    },
    start,
  };
};

const createSwSinkHarness = async (): Promise<SwSinkHarness> => {
  const listeners = new Map<string, (event: MessageEvent) => void>();
  const active = { postMessage: vi.fn() };
  const serviceWorker = {
    addEventListener: (type: string, listener: (event: MessageEvent) => void) =>
      listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
    register: vi.fn(async () => ({ active })),
  };
  const append = vi.fn();
  vi.stubGlobal("navigator", { serviceWorker });
  vi.stubGlobal("window", {
    clearInterval,
    clearTimeout,
    setInterval,
    setTimeout,
  });
  vi.stubGlobal("document", {
    body: { append },
    createElement: () => ({ remove: vi.fn() }),
  });
  const sink = new SwStreamSink("file.bin", 2);
  const started = sink.start();
  await vi.waitFor(() => expect(active.postMessage).toHaveBeenCalledOnce());
  const firstCall = active.postMessage.mock.calls[0];
  if (firstCall === undefined) {
    throw new Error("The sink did not send its init message.");
  }
  const id = (firstCall[0] as { id: string }).id;
  listeners.get("message")?.({
    data: {
      t: "ready",
      id,
      creditBytes: 8,
    },
  } as MessageEvent);
  await vi.waitFor(() => expect(append).toHaveBeenCalledOnce());
  listeners.get("message")?.({
    data: { t: "started", id },
  } as MessageEvent);
  await started;
  return {
    sink,
    sendMessage: (message) =>
      listeners.get("message")?.({ data: { ...message, id } } as MessageEvent),
  };
};

describe("service-worker started handshake", () => {
  it("resolves createSwSink after started and installs the ping timer", async () => {
    vi.useFakeTimers();
    const serviceWorkerHarness = createSwTestHarness(0);
    expect(countMessages(serviceWorkerHarness.outbound, "ready")).toBe(1);
    expect(countMessages(serviceWorkerHarness.outbound, "started")).toBe(1);

    const harness = createPendingSwSinkHarness({});
    await vi.waitFor(() =>
      expect(harness.active.postMessage).toHaveBeenCalledOnce(),
    );
    harness.sendMessage({ t: "ready", creditBytes: 8 });
    await vi.waitFor(() => expect(harness.append).toHaveBeenCalledOnce());
    harness.sendMessage({ t: "started" });

    await expect(harness.start).resolves.toMatchObject({ strategy: "sw" });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(
      harness.active.postMessage.mock.calls.some(
        (call) =>
          typeof call[0] === "object" &&
          call[0] !== null &&
          "t" in call[0] &&
          call[0].t === "ping",
      ),
    ).toBe(true);
  });

  it("rejects when started never arrives and reports a null controller", async () => {
    vi.useFakeTimers();
    const harness = createPendingSwSinkHarness(null);
    await vi.waitFor(() =>
      expect(harness.active.postMessage).toHaveBeenCalledOnce(),
    );
    harness.sendMessage({ t: "ready", creditBytes: 8 });
    await vi.waitFor(() => expect(harness.append).toHaveBeenCalledOnce());

    const rejection = expect(harness.start).rejects.toThrow(
      /The download service worker never received the download request \(controller=null, path=\/__mayo-dl\/[^)]+\)\. The hidden download frame was most likely refused by X-Frame-Options: DENY after falling through to the server\./,
    );
    await vi.advanceTimersByTimeAsync(SW_STARTED_TIMEOUT_MS);
    await rejection;
  });

  it("reports an active controller when started never arrives", async () => {
    vi.useFakeTimers();
    const harness = createPendingSwSinkHarness({});
    await vi.waitFor(() =>
      expect(harness.active.postMessage).toHaveBeenCalledOnce(),
    );
    harness.sendMessage({ t: "ready", creditBytes: 8 });
    await vi.waitFor(() => expect(harness.append).toHaveBeenCalledOnce());

    const rejection = expect(harness.start).rejects.toThrow(
      /The download service worker never received the download request \(controller=active, path=\/__mayo-dl\/[^)]+\)\./,
    );
    await vi.advanceTimersByTimeAsync(SW_STARTED_TIMEOUT_MS);
    await rejection;
  });
});

describe("service-worker close watchdog", () => {
  it("allows commits that keep making progress", async () => {
    vi.useFakeTimers();
    const harness = await createSwSinkHarness();
    const first = harness.sink.write(new Uint8Array([1]));
    const second = harness.sink.write(new Uint8Array([2]));
    const closed = harness.sink.close();

    harness.sendMessage({ t: "credit", sequence: 0, bytes: 1 });
    await expect(first).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(SINK_PROGRESS_WATCHDOG_MS - 1);
    harness.sendMessage({ t: "credit", sequence: 1, bytes: 1 });
    await expect(second).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(SINK_PROGRESS_WATCHDOG_MS - 1);
    harness.sendMessage({ t: "closed" });
    await expect(closed).resolves.toBeUndefined();
  });

  it("fails a silent close once the stall ceiling trips", async () => {
    vi.useFakeTimers();
    const harness = await createSwSinkHarness();
    const closed = harness.sink.close();

    const failure = expect(closed).rejects.toThrow(/stopped responding/i);
    await vi.advanceTimersByTimeAsync(SINK_STALL_ABORT_MS);
    await failure;
  });

  it("records pong liveness with startup grace", async () => {
    vi.useFakeTimers();
    const harness = await createSwSinkHarness();

    expect(harness.sink.isResponsive()).toBe(true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(harness.sink.isResponsive()).toBe(false);

    harness.sendMessage({ t: "pong" });
    expect(harness.sink.isResponsive()).toBe(true);
    await vi.advanceTimersByTimeAsync(44_999);
    expect(harness.sink.isResponsive()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(harness.sink.isResponsive()).toBe(false);
  });
});

interface SwTestController {
  desiredSize: number;
  enqueued: Uint8Array[];
  closeCount: number;
  errorReason: unknown;
  enqueue: (chunk: Uint8Array) => void;
  close: () => void;
  error: (reason: unknown) => void;
}

interface SwTestHarness {
  controller: SwTestController;
  outbound: unknown[];
  sendMessage: (data: unknown) => void;
  pull: () => Promise<void>;
  sendChunk: (sequence: number, byteLength: number) => void;
  close: () => void;
}

const createSwTestHarness = (totalBytes: number): SwTestHarness => {
  const sourceListeners = new Map<string, (event: unknown) => void>();
  const outbound: unknown[] = [];
  const client = { postMessage: (message: unknown) => outbound.push(message) };

  class FakeReadableStream {
    public readonly source: {
      start?: (controller: SwTestController) => void;
      pull?: (controller: SwTestController) => Promise<void>;
      cancel?: (reason: unknown) => void;
    };
    public readonly controller: SwTestController;

    public constructor(source: FakeReadableStream["source"]) {
      this.source = source;
      this.controller = {
        desiredSize: 1,
        enqueued: [],
        closeCount: 0,
        errorReason: undefined,
        enqueue: (chunk) => {
          this.controller.enqueued.push(chunk);
          this.controller.desiredSize = 0;
        },
        close: () => {
          this.controller.closeCount += 1;
        },
        error: (reason) => {
          this.controller.errorReason = reason;
        },
      };
      source.start?.(this.controller);
    }
  }

  class FakeResponse {
    public readonly body: FakeReadableStream;
    public constructor(body: FakeReadableStream) {
      this.body = body;
    }
  }

  const self = {
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      sourceListeners.set(type, listener);
    },
    skipWaiting: () => Promise.resolve(),
    clients: { claim: () => Promise.resolve() },
  };
  runInNewContext(
    readFileSync(
      fileURLToPath(new URL("../public/download.sw.js", import.meta.url)),
      "utf8",
    ),
    {
      self,
      ReadableStream: FakeReadableStream,
      Response: FakeResponse,
      URL,
      Map,
      Promise,
      Error,
      Math,
      Number,
      String,
      Uint8Array,
    },
  );

  const sendMessage = (data: unknown): void => {
    sourceListeners.get("message")?.({ data, source: client });
  };
  sendMessage({
    t: "init",
    id: "transfer-1",
    name: "file.bin",
    totalBytes,
    creditBytes: 8 * 1024 * 1024,
  });
  let response: FakeResponse | undefined;
  sourceListeners.get("fetch")?.({
    request: {
      method: "GET",
      url: "https://example.test/__mayo-dl/transfer-1",
    },
    respondWith: (value: FakeResponse) => {
      response = value;
    },
  });
  if (response === undefined) {
    throw new Error("The service-worker test did not create a response.");
  }

  const stream = response.body;
  return {
    controller: stream.controller,
    outbound,
    sendMessage,
    pull: async () => {
      stream.controller.desiredSize = 1;
      await stream.source.pull?.(stream.controller);
    },
    sendChunk: (sequence, byteLength) => {
      sendMessage({
        t: "chunk",
        id: "transfer-1",
        sequence,
        buffer: new ArrayBuffer(byteLength),
      });
    },
    close: () => sendMessage({ t: "close", id: "transfer-1" }),
  };
};

const countMessages = (messages: readonly unknown[], type: string): number =>
  messages.filter(
    (message) =>
      typeof message === "object" &&
      message !== null &&
      "t" in message &&
      message.t === type,
  ).length;

describe("service-worker pull-driven FIFO", () => {
  it("returns credit only when a pending pull drains a chunk", async () => {
    const harness = createSwTestHarness(1);

    expect(countMessages(harness.outbound, "credit")).toBe(0);
    const pendingPull = harness.pull();
    harness.sendChunk(0, 1);
    await pendingPull;

    expect(harness.controller.enqueued).toHaveLength(1);
    expect(countMessages(harness.outbound, "credit")).toBe(1);
  });

  it("keeps queued bytes bounded by the outstanding credit window", async () => {
    const chunkBytes = 4 * 1024 * 1024;
    const harness = createSwTestHarness(chunkBytes * 4);
    const pendingPull = harness.pull();
    harness.sendChunk(0, chunkBytes);
    await pendingPull;

    harness.sendChunk(1, chunkBytes);
    harness.sendChunk(2, chunkBytes);
    harness.sendChunk(3, chunkBytes);

    expect(harness.controller.enqueued).toHaveLength(1);
    expect(countMessages(harness.outbound, "error")).toBe(1);
    expect(countMessages(harness.outbound, "credit")).toBe(1);
  });

  it("waits to close until every queued chunk has drained", async () => {
    const harness = createSwTestHarness(3);
    const pendingPull = harness.pull();
    harness.sendChunk(0, 1);
    await pendingPull;
    harness.sendChunk(1, 1);
    harness.sendChunk(2, 1);
    harness.close();

    expect(harness.controller.closeCount).toBe(0);
    await harness.pull();
    expect(harness.controller.closeCount).toBe(0);
    await harness.pull();

    expect(harness.controller.closeCount).toBe(1);
    expect(countMessages(harness.outbound, "closed")).toBe(1);
  });
});
