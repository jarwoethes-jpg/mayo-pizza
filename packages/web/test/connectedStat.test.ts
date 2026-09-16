import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  type Listener = (payload?: unknown) => void;

  const peerListeners = new Map<string, Listener>();
  const candidateStats = new Map<string, unknown>([
    [
      "pair",
      {
        type: "candidate-pair",
        state: "succeeded",
        nominated: true,
        localCandidateId: "local",
        remoteCandidateId: "remote",
      },
    ],
    [
      "local-host",
      { id: "local", type: "local-candidate", candidateType: "host" },
    ],
    [
      "local-relay",
      { id: "local-relay", type: "local-candidate", candidateType: "relay" },
    ],
    [
      "remote-srflx",
      { id: "remote", type: "remote-candidate", candidateType: "srflx" },
    ],
  ]);

  const signaling = {
    isOpen: true,
    on: vi.fn((_event: string, _listener: Listener) => () => undefined),
    send: vi.fn(async (_message: unknown) => undefined),
    join: vi.fn(async (_slug: string, _password?: string) => undefined),
    create: vi.fn(async (_password?: string) => ({
      slug: "room",
      uploaderToken: "token",
    })),
    requestIceConfig: vi.fn(async () => []),
    close: vi.fn(),
  };

  const peer = {
    connectionState: {
      subscribe: vi.fn(
        (_listener: (state: RTCPeerConnectionState) => void) => () => undefined,
      ),
    },
    iceConnectionState: {
      subscribe: vi.fn(
        (_listener: (state: RTCIceConnectionState) => void) => () => undefined,
      ),
    },
    ctrl: undefined,
    data: undefined,
    maxMessageSize: undefined,
    ready: Promise.resolve(),
    on: vi.fn((event: string, listener: Listener) => {
      peerListeners.set(event, listener);
      return () => peerListeners.delete(event);
    }),
    onCtrl: vi.fn(() => () => undefined),
    sendPing: vi.fn(() => "nonce"),
    debugDrop: vi.fn(),
    getStats: vi.fn(async () => candidateStats as RTCStatsReport),
    close: vi.fn(),
  };

  const transfer = {
    destroy: vi.fn(),
    acceptTransfer: vi.fn(),
    rejectTransfer: vi.fn(),
    startSend: vi.fn(async (_file: File) => undefined),
    startFolderSend: vi.fn(async () => undefined),
  };

  const effects: Array<() => unknown> = [];

  return {
    candidateStats,
    effects,
    peer,
    peerListeners,
    signaling,
    transfer,
  };
});

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    useEffect: (effect: () => unknown): void => {
      harness.effects.push(effect);
    },
  };
});

vi.mock("react-dom/client", () => ({
  createRoot: () => ({ render: () => undefined }),
}));
vi.mock("../src/styles.css", () => ({}));
vi.mock("../src/net/peer", () => ({
  createPeer: () => harness.peer,
}));
vi.mock("../src/net/signaling", () => ({
  createSignalingClient: () => harness.signaling,
}));
vi.mock("../src/net/transfer", () => ({
  createTransferController: () => harness.transfer,
}));

const flushPromises = async (): Promise<void> => {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve();
  }
};

describe("connected route telemetry", () => {
  let RoomView: typeof import("../src/main").RoomView;

  beforeAll(async () => {
    vi.stubGlobal("document", {
      getElementById: vi.fn(() => ({})),
    });
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      clearInterval: vi.fn(),
      setInterval: vi.fn(() => 1),
      location: {
        host: "mayo.test",
        origin: "https://mayo.test",
        protocol: "https:",
      },
    });
    ({ RoomView } = await import("../src/main"));
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("sends candidate diagnostics with the connected stat from data-open", async () => {
    harness.effects.length = 0;
    renderToStaticMarkup(
      createElement(RoomView, { role: "downloader", slug: "room" }),
    );
    expect(harness.effects).toHaveLength(3);
    harness.effects[0]?.();
    expect(harness.peerListeners.has("data-open")).toBe(true);

    harness.peerListeners.get("data-open")?.();
    await flushPromises();

    expect(harness.signaling.send).toHaveBeenCalledWith({
      t: "stat",
      event: "connected",
      route: "direct",
      localCandidateTypes: ["host", "relay"],
      remoteCandidateTypes: ["srflx"],
      hadRelayCandidate: true,
    });
  });
});
