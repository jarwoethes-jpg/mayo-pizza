import { describe, expect, it } from "vitest";
import {
  classifySelectedRoute,
  readSelectedRouteStats,
} from "../src/net/route";

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

  it("reads the nominated relay pair and transport stats", () => {
    const stats = new Map([
      [
        "pair",
        {
          type: "candidate-pair",
          state: "succeeded",
          nominated: true,
          localCandidateId: "local",
          remoteCandidateId: "remote",
          currentRoundTripTime: 0.025,
          availableOutgoingBitrate: 1_250_000,
          bytesSent: 100,
          bytesReceived: 200,
          timestamp: 1_234.5,
        },
      ],
      [
        "local",
        {
          id: "local",
          type: "local-candidate",
          candidateType: "relay",
          protocol: "udp",
          relayProtocol: "tcp",
        },
      ],
      [
        "remote",
        {
          id: "remote",
          type: "remote-candidate",
          candidateType: "host",
        },
      ],
    ]);

    expect(readSelectedRouteStats(stats)).toEqual({
      route: "relay",
      protocol: "udp",
      relayProtocol: "tcp",
      currentRoundTripTime: 0.025,
      availableOutgoingBitrate: 1_250_000,
      bytesSent: 100,
      bytesReceived: 200,
      timestamp: 1_234.5,
    });
  });

  it.each([
    ["missing", undefined],
    ["NaN", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
  ])("leaves %s pair timestamps undefined", (_name, timestamp) => {
    const pair: Record<string, unknown> = {
      type: "candidate-pair",
      state: "succeeded",
      nominated: true,
      localCandidateId: "local",
      remoteCandidateId: "remote",
    };
    if (timestamp !== undefined) {
      pair.timestamp = timestamp;
    }
    const stats = new Map([
      ["pair", pair],
      [
        "local",
        { id: "local", type: "local-candidate", candidateType: "host" },
      ],
      [
        "remote",
        {
          id: "remote",
          type: "remote-candidate",
          candidateType: "host",
        },
      ],
    ]);

    expect(readSelectedRouteStats(stats).timestamp).toBeUndefined();
  });

  it("keeps unavailable pair details undefined", () => {
    expect(readSelectedRouteStats(undefined)).toEqual({
      route: undefined,
      protocol: undefined,
      relayProtocol: undefined,
      currentRoundTripTime: undefined,
      availableOutgoingBitrate: undefined,
      bytesSent: undefined,
      bytesReceived: undefined,
      timestamp: undefined,
    });
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
