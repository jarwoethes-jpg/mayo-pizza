/** The transport path selected by the nominated ICE candidate pair. */
export type SelectedRoute = "direct" | "relay";

type StatsCollection =
  | ReadonlyMap<string, unknown>
  | Iterable<unknown>
  | undefined;

export interface SelectedRouteStats {
  route: SelectedRoute | undefined;
  protocol: "udp" | "tcp" | undefined;
  relayProtocol: "udp" | "tcp" | undefined;
  currentRoundTripTime: number | undefined;
  availableOutgoingBitrate: number | undefined;
  bytesSent: number | undefined;
  bytesReceived: number | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const valuesOf = (stats: StatsCollection): unknown[] => {
  try {
    if (stats === undefined) {
      return [];
    }
    if ("values" in stats && typeof stats.values === "function") {
      return Array.from(stats.values());
    }
    if (
      !(Symbol.iterator in Object(stats)) ||
      typeof (stats as Iterable<unknown>)[Symbol.iterator] !== "function"
    ) {
      return [];
    }
    return Array.from(stats);
  } catch {
    return [];
  }
};

interface SelectedPairReports {
  pair: Record<string, unknown>;
  local: Record<string, unknown>;
  remote: Record<string, unknown>;
}

const findSelectedPair = (
  stats: StatsCollection,
): SelectedPairReports | undefined => {
  try {
    const reports = valuesOf(stats);
    const pair = reports.find(
      (report): report is Record<string, unknown> =>
        isRecord(report) &&
        report.type === "candidate-pair" &&
        report.state === "succeeded" &&
        report.nominated === true &&
        typeof report.localCandidateId === "string" &&
        typeof report.remoteCandidateId === "string",
    );
    if (pair === undefined) {
      return undefined;
    }
    const local = reports.find(
      (report) =>
        isRecord(report) &&
        report.id === pair.localCandidateId &&
        report.type === "local-candidate",
    );
    const remote = reports.find(
      (report) =>
        isRecord(report) &&
        report.id === pair.remoteCandidateId &&
        report.type === "remote-candidate",
    );
    if (!isRecord(local) || !isRecord(remote)) {
      return undefined;
    }
    return { pair, local, remote };
  } catch {
    return undefined;
  }
};

const classifyPair = ({
  local,
  remote,
}: SelectedPairReports): SelectedRoute | undefined => {
  const candidateTypes = [local.candidateType, remote.candidateType];
  if (candidateTypes.some((type) => type === "relay")) {
    return "relay";
  }
  if (
    candidateTypes.every(
      (type) => type === "host" || type === "srflx" || type === "prflx",
    )
  ) {
    return "direct";
  }
  return undefined;
};

const readProtocol = (value: unknown): "udp" | "tcp" | undefined =>
  value === "udp" || value === "tcp" ? value : undefined;

const readFiniteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** Classifies the nominated succeeded ICE pair without making network decisions. */
export const classifySelectedRoute = (
  stats: StatsCollection,
): SelectedRoute | undefined => {
  const selectedPair = findSelectedPair(stats);
  return selectedPair === undefined ? undefined : classifyPair(selectedPair);
};

/** Reads the nominated ICE pair and its optional transport and byte counters. */
export const readSelectedRouteStats = (
  stats: StatsCollection,
): SelectedRouteStats => {
  const unavailable: SelectedRouteStats = {
    route: undefined,
    protocol: undefined,
    relayProtocol: undefined,
    currentRoundTripTime: undefined,
    availableOutgoingBitrate: undefined,
    bytesSent: undefined,
    bytesReceived: undefined,
  };
  try {
    const selectedPair = findSelectedPair(stats);
    if (selectedPair === undefined) {
      return unavailable;
    }
    const { pair, local } = selectedPair;
    return {
      route: classifyPair(selectedPair),
      protocol: readProtocol(local.protocol),
      relayProtocol:
        local.candidateType === "relay"
          ? readProtocol(local.relayProtocol)
          : undefined,
      currentRoundTripTime: readFiniteNumber(pair.currentRoundTripTime),
      availableOutgoingBitrate: readFiniteNumber(pair.availableOutgoingBitrate),
      bytesSent: readFiniteNumber(pair.bytesSent),
      bytesReceived: readFiniteNumber(pair.bytesReceived),
    };
  } catch {
    return unavailable;
  }
};
