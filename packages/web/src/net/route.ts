/** The transport path selected by the nominated ICE candidate pair. */
export type SelectedRoute = "direct" | "relay";

type StatsCollection =
  | ReadonlyMap<string, unknown>
  | Iterable<unknown>
  | undefined;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const valuesOf = (stats: StatsCollection): unknown[] => {
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
};

/** Classifies the nominated succeeded ICE pair without making network decisions. */
export const classifySelectedRoute = (
  stats: StatsCollection,
): SelectedRoute | undefined => {
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
