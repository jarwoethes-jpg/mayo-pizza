import type { PeerConnection } from "./peer";
import { readCandidateTypeStats } from "./route";
import type { SignalingClient } from "./signaling";

export type ConnectionFailurePhase = "ice" | "connection" | "stall";

/** Sends failure telemetry without allowing stats or signaling to affect transport recovery. */
export const sendConnectionFailureStat = (
  peer: Pick<PeerConnection, "getStats">,
  signaling: Pick<SignalingClient, "send">,
  phase: ConnectionFailurePhase,
  getStats: () => Promise<RTCStatsReport> = () => peer.getStats(),
): void => {
  void getStats()
    .then((stats) => readCandidateTypeStats(stats))
    .catch(() => undefined)
    .then((candidateStats) =>
      signaling.send({
        t: "stat",
        event: "failed",
        phase,
        ...(candidateStats === undefined ? {} : candidateStats),
      }),
    )
    .catch(() => {
      // Failure telemetry is deliberately best-effort and never gates a transfer.
    });
};

export const installCheckingConnectionFailureReporter = (
  target: Pick<Window, "addEventListener" | "removeEventListener">,
  getIceConnectionState: () => RTCIceConnectionState,
  report: () => void,
): (() => void) => {
  const onPageHide = (): void => {
    if (getIceConnectionState() === "checking") {
      report();
    }
  };
  target.addEventListener("pagehide", onPageHide);
  return () => target.removeEventListener("pagehide", onPageHide);
};
