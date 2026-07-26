import { afterEach, describe, expect, it, vi } from "vitest";
import { getReconnectDelay, SignalingClient } from "../src/net/signaling";

class FakeWebSocket {
  public static instances: FakeWebSocket[] = [];
  public readyState = 0;
  public onopen: (() => void) | null = null;
  public onmessage: ((event: { data: unknown }) => void) | null = null;
  public onerror: ((event: Event) => void) | null = null;
  public onclose:
    | ((event: { code: number; reason: string; wasClean: boolean }) => void)
    | null = null;

  public constructor() {
    FakeWebSocket.instances.push(this);
  }

  public send(): void {}

  public close(): void {
    this.readyState = 3;
  }
}

describe("signaling reconnect schedule", () => {
  afterEach(() => {
    vi.useRealTimers();
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
});
