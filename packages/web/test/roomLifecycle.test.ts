import { describe, expect, it, vi } from "vitest";
import {
  canSilentlyRemintRoom,
  MAX_AUTOMATIC_ROOM_REMINTS,
  ROOM_HEARTBEAT_INTERVAL_MS,
  resolveRoomHeartbeatInterval,
  startRoomHeartbeat,
} from "../src/roomLifecycle";

describe("room heartbeat", () => {
  it.each([
    [1_000, 1_000],
    [999, 1_000],
    [30_000, 30_000],
  ])("clamps interval %s to %s", (value, expected) => {
    expect(resolveRoomHeartbeatInterval(value)).toBe(expected);
  });

  it.each([
    undefined,
    null,
    "1000",
    Number.NaN,
    Number.POSITIVE_INFINITY,
    0,
    -1,
  ])("falls back for invalid interval %s", (value) => {
    expect(resolveRoomHeartbeatInterval(value)).toBe(
      ROOM_HEARTBEAT_INTERVAL_MS,
    );
  });

  it("uses a ten-minute interval, skips closed sockets, and cleans up", () => {
    let scheduledCallback: (() => void) | undefined;
    const timer = {} as ReturnType<typeof setInterval>;
    const schedule = vi.fn((callback: () => void, delay: number) => {
      scheduledCallback = callback;
      expect(delay).toBe(ROOM_HEARTBEAT_INTERVAL_MS);
      return timer;
    });
    const cancel = vi.fn();
    const isSocketOpen = vi.fn(() => true);
    const sendHeartbeat = vi.fn(() => Promise.resolve());

    const stop = startRoomHeartbeat(
      isSocketOpen,
      sendHeartbeat,
      schedule,
      cancel,
    );

    scheduledCallback?.();
    expect(sendHeartbeat).toHaveBeenCalledOnce();

    isSocketOpen.mockReturnValue(false);
    scheduledCallback?.();
    expect(sendHeartbeat).toHaveBeenCalledOnce();

    stop();
    expect(cancel).toHaveBeenCalledWith(timer);
  });
});

describe("silent room re-mint guard", () => {
  it("allows only an idle uploader below the automatic cap", () => {
    expect(canSilentlyRemintRoom("uploader", false, false, false, 0)).toBe(
      true,
    );
    expect(
      canSilentlyRemintRoom(
        "uploader",
        false,
        false,
        false,
        MAX_AUTOMATIC_ROOM_REMINTS - 1,
      ),
    ).toBe(true);
  });

  it.each([
    ["downloader", false, false, false, 0],
    ["uploader", true, false, false, 0],
    ["uploader", false, true, false, 0],
    ["uploader", false, false, true, 0],
    ["uploader", false, false, false, MAX_AUTOMATIC_ROOM_REMINTS],
  ] as const)(
    "rejects role=%s staged=%s peerConnected=%s transferInProgress=%s count=%s",
    (role, staged, peerConnected, transferInProgress, count) => {
      expect(
        canSilentlyRemintRoom(
          role,
          staged,
          peerConnected,
          transferInProgress,
          count,
        ),
      ).toBe(false);
    },
  );
});
