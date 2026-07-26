/// <reference types="vite/client" />

interface Window {
  /** Runtime override used by local deployments and Playwright. */
  __MAYO_SIGNALING_URL__?: string;
  /** Runtime relay-policy override used by the forced-relay e2e run. */
  __MAYO_FORCE_RELAY__?: boolean;
  __MAYO_CORRUPT_FRAME__?: boolean;
  /** Test-only sink strategy or factory selected before the app loads. */
  __MAYO_SINK__?: unknown;
  __MAYO_SINK_STRATEGY__?: "fsa" | "sw" | "blob" | "null";
  __MAYO_TRANSFER_STATS__?: {
    bufferedAmount: number;
    maxBufferedAmount: number;
  };
  /** Deterministic drop hook enabled only in development or explicit e2e pages. */
  __MAYO_E2E__?: boolean;
  __MAYO_DEBUG_DROP__?: () => void;
}
