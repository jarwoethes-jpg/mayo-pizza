const LOCAL_BASE_URL = "http://127.0.0.1:5173";
const LOCAL_SIGNALING_URL = "ws://127.0.0.1:3100/ws";

const configuredBaseURL = process.env.PLAYWRIGHT_BASE_URL;
export const baseURL = configuredBaseURL ?? LOCAL_BASE_URL;

const parsedBaseURL = new URL(baseURL);

const isLoopbackHostname = (hostname: string): boolean => {
  const lowercased = hostname.toLowerCase();
  const normalized =
    lowercased.startsWith("[") && lowercased.endsWith("]")
      ? lowercased.slice(1, -1)
      : lowercased;
  if (normalized === "localhost" || normalized === "::1") {
    return true;
  }

  const octets = normalized.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.slice(1).every((octet) => {
      const value = Number(octet);
      return /^\d+$/.test(octet) && value >= 0 && value <= 255;
    })
  );
};

export const isRemoteTarget =
  configuredBaseURL !== undefined &&
  !isLoopbackHostname(parsedBaseURL.hostname);

const derivedSignalingURL = new URL("/ws", parsedBaseURL);
derivedSignalingURL.protocol =
  parsedBaseURL.protocol === "https:" ? "wss:" : "ws:";

export const signalingUrl =
  process.env.PLAYWRIGHT_SIGNALING_URL ??
  (isRemoteTarget ? derivedSignalingURL.toString() : LOCAL_SIGNALING_URL);
