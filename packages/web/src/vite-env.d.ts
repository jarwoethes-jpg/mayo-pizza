/// <reference types="vite/client" />

interface Window {
  /** Runtime override used by local deployments and Playwright. */
  __MAYO_SIGNALING_URL__?: string;
  /** Runtime relay-policy override used by the forced-relay e2e run. */
  __MAYO_FORCE_RELAY__?: boolean;
}
