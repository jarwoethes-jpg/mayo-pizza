import { afterEach, describe, expect, it, vi } from "vitest";
import { createPeer, RemoteIceCandidateQueue } from "../src/net/peer";
import type { SignalingClient } from "../src/net/signaling";

type Listener = (event?: unknown) => void;

class FakeDataChannel {
  public readonly label: string;
  public binaryType: BinaryType = "arraybuffer";
  public bufferedAmountLowThreshold = 0;
  public readonly readyState: RTCDataChannelState = "open";
  private readonly listeners = new Map<string, Set<Listener>>();

  public constructor(label: string) {
    this.label = label;
  }

  public addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  public removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  public send(): void {
    // The test only exercises signaling and rebuild ordering.
  }
}

class FakePeerConnection {
  public static instances: FakePeerConnection[] = [];
  public connectionState: RTCPeerConnectionState = "new";
  public iceConnectionState: RTCIceConnectionState = "new";
  public readonly sctp = { maxMessageSize: 1_000_000 };
  public localDescription: RTCSessionDescription | null = null;
  public onconnectionstatechange: (() => void) | null = null;
  public oniceconnectionstatechange: (() => void) | null = null;
  public onicecandidate: ((event: { candidate: null }) => void) | null = null;
  public ondatachannel: ((event: { channel: FakeDataChannel }) => void) | null =
    null;

  public constructor(_configuration: RTCConfiguration) {
    FakePeerConnection.instances.push(this);
  }

  public createDataChannel(label: string): FakeDataChannel {
    return new FakeDataChannel(label);
  }

  public async createOffer(): Promise<RTCSessionDescriptionInit> {
    return {
      type: "offer",
      sdp: `offer-${FakePeerConnection.instances.length}`,
    };
  }

  public async setLocalDescription(
    description: RTCSessionDescriptionInit,
  ): Promise<void> {
    this.localDescription = description as RTCSessionDescription;
  }

  public async setRemoteDescription(): Promise<void> {
    // No SDP negotiation is needed for this state-machine test.
  }

  public async addIceCandidate(): Promise<void> {
    // No ICE candidates are needed for this state-machine test.
  }

  public async createAnswer(): Promise<RTCSessionDescriptionInit> {
    return { type: "answer", sdp: "answer" };
  }

  public restartIce(): void {
    throw new Error("restart unavailable in fake");
  }

  public close(): void {
    this.connectionState = "closed";
  }
}

const flushPromises = async (): Promise<void> => {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
  }
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  FakePeerConnection.instances = [];
});

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

describe("peer rebuild coalescing", () => {
  it("runs one follow-up pass when a rebuild signal and peer rejoin overlap", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("RTCPeerConnection", FakePeerConnection);

    const listeners = new Map<string, Set<(payload: never) => void>>();
    const signaling = {
      isOpen: true,
      on(event: string, listener: (payload: never) => void) {
        const eventListeners = listeners.get(event) ?? new Set();
        eventListeners.add(listener);
        listeners.set(event, eventListeners);
        return () => eventListeners.delete(listener);
      },
      requestIceConfig: async () => [],
      sendSignal: async (_to: string, payload: unknown) => {
        if (
          typeof payload === "object" &&
          payload !== null &&
          (payload as { mayo?: unknown }).mayo === "rebuild"
        ) {
          rebuildSignalCount += 1;
          if (rebuildSignalCount === 1) {
            await firstRebuildSignal;
          }
        }
      },
    } as unknown as SignalingClient;
    const emit = (event: string, payload: never): void => {
      for (const listener of listeners.get(event) ?? []) {
        listener(payload);
      }
    };
    let releaseFirstRebuild!: () => void;
    const firstRebuildSignal = new Promise<void>((resolve) => {
      releaseFirstRebuild = resolve;
    });
    let rebuildSignalCount = 0;
    const peer = createPeer("uploader", signaling);
    let exhausted = false;
    peer.on("exhausted", () => {
      exhausted = true;
    });

    await peer.ready;
    emit("peer-joined", { t: "peer-joined", peerId: "remote" } as never);
    await flushPromises();

    const firstPeer = FakePeerConnection.instances[0];
    if (firstPeer === undefined) {
      throw new Error("The fake peer was not constructed.");
    }
    firstPeer.connectionState = "failed";
    firstPeer.onconnectionstatechange?.();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(500);
    await flushPromises();
    expect(FakePeerConnection.instances).toHaveLength(2);

    emit("signal", {
      t: "signal",
      from: "remote",
      payload: { mayo: "rebuild" },
    } as never);
    emit("peer-left", { t: "peer-left", peerId: "remote" } as never);
    emit("peer-joined", { t: "peer-joined", peerId: "remote-2" } as never);
    await flushPromises();
    releaseFirstRebuild();
    await flushPromises();

    expect(FakePeerConnection.instances).toHaveLength(3);
    expect(rebuildSignalCount).toBe(1);
    expect(exhausted).toBe(false);
    expect(peer.connectionState.value).toBe("connecting");
    peer.close();
  });
});
