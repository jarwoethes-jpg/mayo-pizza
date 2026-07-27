import { afterEach, describe, expect, it, vi } from "vitest";
import { getReconnectDelay, SignalingClient } from "../src/net/signaling";

class FakeWebSocket {
  public static instances: FakeWebSocket[] = [];
  public readyState = 0;
  public readonly sent: string[] = [];
  public onopen: (() => void) | null = null;
  public onmessage: ((event: { data: unknown }) => void) | null = null;
  public onerror: ((event: Event) => void) | null = null;
  public onclose:
    | ((event: { code: number; reason: string; wasClean: boolean }) => void)
    | null = null;

  public constructor() {
    FakeWebSocket.instances.push(this);
  }

  public send(message: string): void {
    this.sent.push(message);
  }

  public close(): void {
    this.readyState = 3;
  }
}

describe("signaling reconnect schedule", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    FakeWebSocket.instances = [];
  });

  it("doubles from one second and caps at thirty seconds", () => {
    expect(getReconnectDelay(0, () => 0.5)).toBe(1_000);
    expect(getReconnectDelay(1, () => 0.5)).toBe(2_000);
    expect(getReconnectDelay(5, () => 0.5)).toBe(30_000);
    expect(getReconnectDelay(50, () => 1)).toBe(30_000);
  });

  it("uses the first backoff slot before reconnecting", async () => {
    vi.useFakeTimers();
    const client = new SignalingClient({
      url: "ws://example.test/ws",
      random: () => 0.5,
      webSocketFactory: () => new FakeWebSocket() as unknown as WebSocket,
    });

    const connection = client.connect();
    const first = FakeWebSocket.instances[0];
    if (first === undefined) {
      throw new Error("The first fake socket was not created.");
    }
    first.readyState = 1;
    first.onopen?.();
    await connection;
    first.onclose?.({ code: 1006, reason: "", wasClean: false });

    await vi.advanceTimersByTimeAsync(999);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(2);
    client.close();
  });

  it("binds the default timer before scheduling a reconnect", async () => {
    const nativeSetTimeout = globalThis.setTimeout;
    let scheduledCallback:
      | Parameters<typeof globalThis.setTimeout>[0]
      | undefined;
    const defaultTimer = vi.fn(function (
      this: unknown,
      callback: Parameters<typeof globalThis.setTimeout>[0],
      delay?: number,
    ): ReturnType<typeof globalThis.setTimeout> {
      expect(this).toBe(globalThis);
      scheduledCallback = callback;
      return nativeSetTimeout.call(globalThis, () => undefined, delay);
    });
    vi.stubGlobal("setTimeout", defaultTimer);

    const client = new SignalingClient({
      url: "ws://example.test/ws",
      random: () => 0.5,
      webSocketFactory: () => new FakeWebSocket() as unknown as WebSocket,
    });
    const connection = client.connect();
    const first = FakeWebSocket.instances[0];
    if (first === undefined) {
      throw new Error("The first fake socket was not created.");
    }
    first.readyState = 1;
    first.onopen?.();
    await connection;

    expect(() =>
      first.onclose?.({ code: 1006, reason: "drop", wasClean: false }),
    ).not.toThrow();
    expect(defaultTimer).toHaveBeenCalledWith(expect.any(Function), 1_000);
    expect(scheduledCallback).toBeDefined();
    client.close();
  });

  it("rejoins the remembered uploader room after an unexpected socket close", async () => {
    vi.useFakeTimers();
    const client = new SignalingClient({
      url: "ws://example.test/ws",
      random: () => 0.5,
      webSocketFactory: () => new FakeWebSocket() as unknown as WebSocket,
    });
    const firstConnection = client.connect();
    const first = FakeWebSocket.instances[0];
    if (first === undefined) {
      throw new Error("The first fake socket was not created.");
    }
    first.readyState = 1;
    first.onopen?.();
    await firstConnection;

    const createPromise = client.create();
    await Promise.resolve();
    await Promise.resolve();
    expect(JSON.parse(first.sent[0] ?? "{}") as unknown).toEqual({
      t: "create",
    });
    first.onmessage?.({
      data: JSON.stringify({
        t: "created",
        slug: "mushroom-olive-basil-42",
        uploaderToken: "uploader-token",
      }),
    });
    await createPromise;

    const resumed = vi.fn();
    client.on("room-resumed", resumed);
    first.onclose?.({ code: 1006, reason: "drop", wasClean: false });
    await vi.advanceTimersByTimeAsync(1_000);
    const second = FakeWebSocket.instances[1];
    if (second === undefined) {
      throw new Error("The reconnecting fake socket was not created.");
    }
    second.readyState = 1;
    second.onopen?.();
    expect(JSON.parse(second.sent[0] ?? "{}") as unknown).toEqual({
      t: "join",
      slug: "mushroom-olive-basil-42",
      uploaderToken: "uploader-token",
    });
    second.onmessage?.({
      data: JSON.stringify({
        t: "joined",
        peerId: "new-uploader-peer",
        role: "uploader",
      }),
    });
    await vi.waitFor(() => expect(resumed).toHaveBeenCalledOnce());
    client.close();
  });
});
