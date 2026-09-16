import { describe, expect, it, vi } from "vitest";
import {
  installCheckingConnectionFailureReporter,
  sendConnectionFailureStat,
} from "../src/net/failure";

const flushPromises = async (): Promise<void> => {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
};

describe("connection failure telemetry", () => {
  it("sends a stall phase with candidate type stats", async () => {
    const peer = {
      getStats: vi.fn(
        async () =>
          new Map([
            ["local-host", { type: "local-candidate", candidateType: "host" }],
            [
              "local-relay",
              { type: "local-candidate", candidateType: "relay" },
            ],
            [
              "remote-srflx",
              { type: "remote-candidate", candidateType: "srflx" },
            ],
          ]) as RTCStatsReport,
      ),
    };
    const send = vi.fn(async () => undefined);

    sendConnectionFailureStat(peer, { send }, "stall");
    await flushPromises();

    expect(send).toHaveBeenCalledWith({
      t: "stat",
      event: "failed",
      phase: "stall",
      localCandidateTypes: ["host", "relay"],
      remoteCandidateTypes: ["srflx"],
      hadRelayCandidate: true,
    });
  });

  it("reports only checking connections on pagehide and removes the listener", () => {
    let pagehide: (() => void) | undefined;
    const target = {
      addEventListener: vi.fn((_type: string, listener: () => void) => {
        pagehide = listener;
      }),
      removeEventListener: vi.fn(),
    } as unknown as Window;
    let state: RTCIceConnectionState = "checking";
    const report = vi.fn();

    const uninstall = installCheckingConnectionFailureReporter(
      target,
      () => state,
      report,
    );
    pagehide?.();
    state = "connected";
    pagehide?.();
    uninstall();

    expect(report).toHaveBeenCalledOnce();
    expect(target.addEventListener).toHaveBeenCalledOnce();
    expect(target.removeEventListener).toHaveBeenCalledOnce();
  });
});
