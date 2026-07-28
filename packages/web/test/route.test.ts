import { describe, expect, it } from "vitest";
import { classifySelectedRoute } from "../src/net/route";

describe("selected WebRTC route", () => {
  it.each([
    ["relay local", "relay", "host", "relay"],
    ["relay remote", "srflx", "relay", "relay"],
    ["host and srflx", "host", "srflx", "direct"],
  ])("classifies %s", (_name, localType, remoteType, expected) => {
    const stats = new Map([
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
        "local",
        { id: "local", type: "local-candidate", candidateType: localType },
      ],
      [
        "remote",
        {
          id: "remote",
          type: "remote-candidate",
          candidateType: remoteType,
        },
      ],
    ]);

    expect(classifySelectedRoute(stats)).toBe(expected);
  });

  it.each([
    undefined,
    new Map(),
    new Map([["garbage", { nope: true }]]),
    {} as unknown as ReadonlyMap<string, unknown>,
  ])("returns undefined for unavailable stats: %s", (stats) => {
    expect(classifySelectedRoute(stats)).toBeUndefined();
  });
});
