import type { PeerRole } from "./net/peer";

export const ROOM_HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000;
export const MIN_ROOM_HEARTBEAT_INTERVAL_MS = 1_000;
export const MAX_AUTOMATIC_ROOM_REMINTS = 3;

type RoomHeartbeatTimer = ReturnType<typeof globalThis.setInterval>;
type RoomHeartbeatScheduler = (
  callback: () => void,
  delay: number,
) => RoomHeartbeatTimer;
type RoomHeartbeatCanceller = (timer: RoomHeartbeatTimer) => void;

/** Resolves a runtime heartbeat override without allowing an overly tight timer. */
export const resolveRoomHeartbeatInterval = (override: unknown): number => {
  if (
    typeof override !== "number" ||
    !Number.isFinite(override) ||
    override <= 0
  ) {
    return ROOM_HEARTBEAT_INTERVAL_MS;
  }
  return Math.max(MIN_ROOM_HEARTBEAT_INTERVAL_MS, override);
};

/** Starts an idle-room heartbeat and returns its teardown function. */
export const startRoomHeartbeat = (
  isSocketOpen: () => boolean,
  sendHeartbeat: () => Promise<void>,
  schedule: RoomHeartbeatScheduler = (callback, delay) =>
    globalThis.setInterval(callback, delay),
  cancel: RoomHeartbeatCanceller = (timer) => globalThis.clearInterval(timer),
  intervalMs = ROOM_HEARTBEAT_INTERVAL_MS,
): (() => void) => {
  const timer = schedule(() => {
    if (!isSocketOpen()) {
      return;
    }
    try {
      void sendHeartbeat().catch(() => undefined);
    } catch {
      // A teardown can race the timer; a heartbeat failure must not affect the idle view.
    }
  }, intervalMs);
  return () => cancel(timer);
};

/** Returns whether an expired room may be replaced without showing a warning. */
export const canSilentlyRemintRoom = (
  role: PeerRole,
  stagedSelection: boolean,
  peerConnected: boolean,
  transferInProgress: boolean,
  automaticRemintCount: number,
): boolean =>
  role === "uploader" &&
  !stagedSelection &&
  !peerConnected &&
  !transferInProgress &&
  automaticRemintCount < MAX_AUTOMATIC_ROOM_REMINTS;
