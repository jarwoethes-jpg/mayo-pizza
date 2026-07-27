import type { PeerRole } from "../net/peer";

export interface FailureCopy {
  message: string;
  heading: string;
}

/** Maps technical failures to candid primary copy while keeping diagnostics separate. */
export const getFailureCopy = (reason: string, role: PeerRole): FailureCopy => {
  const normalized = reason.toLowerCase();
  if (normalized.includes("bad_slug")) {
    return {
      heading: "That link has gone stale.",
      message:
        "Slice missed its train! This link has expired or was typed a little differently. Ask for a fresh one and try again.",
    };
  }
  if (normalized.includes("sink") || normalized.includes("save")) {
    return {
      heading: "The save spot got messy.",
      message:
        "Slice dropped! Your download spot got a little messy. Choose a fresh save spot and we’ll give it another go.",
    };
  }
  if (
    normalized.includes("hash") ||
    normalized.includes("integrity") ||
    normalized.includes("verified") ||
    normalized.includes("bytes did not line up")
  ) {
    return {
      heading: "The crumbs did not line up.",
      message:
        "Slice dropped! The bytes did not line up on the way over. Try that slice again so we can check every crumb.",
    };
  }
  if (normalized.includes("cancel") || normalized.includes("rejected")) {
    return {
      heading: "Slice put back on the counter.",
      message:
        role === "uploader"
          ? "Slice paused! The receiver passed on this one. Pick another slice whenever you’re ready."
          : "Slice paused! You put this one back for now. Pick another whenever you’re ready.",
    };
  }
  if (normalized.includes("sender") || normalized.includes("peer")) {
    return {
      heading: "The sender stepped away.",
      message:
        "Slice is waiting! The sender stepped away before the handoff finished. Ask them to open the room again for a fresh slice.",
    };
  }
  return {
    heading: "The connection got a little messy.",
    message:
      "Slice dropped! Our connection got a little messy. We’re getting a fresh one ready, but in the meantime, check your Wi-Fi!",
  };
};
