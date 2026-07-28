import { describe, expect, it } from "vitest";
import { getFailureCopy } from "../src/ui/copy";
import { formatBytes, formatEta, formatTransferRate } from "../src/ui/format";
import { initialTransferUiState, transferUiReducer } from "../src/ui/state";

describe("UI byte formatting", () => {
  it("formats zero and binary unit boundaries", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.00 KiB");
    expect(formatBytes(1024 ** 2)).toBe("1.00 MiB");
    expect(formatTransferRate(1024 ** 2)).toBe("1.00 MiB/s");
  });

  it("formats sub-second, minute, and hour ETAs", () => {
    expect(formatEta(0, 1)).toBe("Done");
    expect(formatEta(1, 2)).toBe("<1s");
    expect(formatEta(59, 1)).toBe("59s");
    expect(formatEta(60, 1)).toBe("1m");
    expect(formatEta(3600, 1)).toBe("1h");
    expect(formatEta(3661, 1)).toBe("1h 1m");
    expect(formatEta(1, 0)).toBe("—");
  });
});

describe("transfer UI reducer", () => {
  const result = {
    transferId: "slice-1",
    verified: true,
    sha256: "abc",
  };

  it("makes the happy path explicit", () => {
    const staged = transferUiReducer(initialTransferUiState, { type: "stage" });
    const transferring = transferUiReducer(staged, { type: "progress" });
    const complete = transferUiReducer(transferring, {
      type: "result",
      result,
    });
    expect(staged.phase).toBe("staged");
    expect(transferring.phase).toBe("transferring");
    expect(complete.phase).toBe("complete");
  });

  it("keeps failure and cancellation visible instead of pending", () => {
    const failed = transferUiReducer(initialTransferUiState, {
      type: "error",
      message: "The download sink failed.",
    });
    const cancelled = transferUiReducer(initialTransferUiState, {
      type: "cancel",
    });
    const verificationFailed = transferUiReducer(initialTransferUiState, {
      type: "result",
      result: { ...result, verified: false },
    });
    expect(failed).toMatchObject({ phase: "failed" });
    expect(cancelled.phase).toBe("cancelled");
    expect(verificationFailed).toMatchObject({ phase: "failed" });
  });
});

describe("failure copy mapping", () => {
  it("keeps signaling socket closures on the connection branch", () => {
    for (const reason of [
      "The signaling socket is not open.",
      "The signaling socket closed.",
      "The signaling socket closed before opening.",
      "The signaling client was closed.",
      "The signaling connection failed.",
    ]) {
      const copy = getFailureCopy(reason, "downloader");
      expect(copy.heading).toBe("The connection got a little messy.");
      expect(copy.heading).not.toBe("The save spot got messy.");
    }
    expect(
      getFailureCopy("The download sink failed.", "downloader").heading,
    ).toBe("The save spot got messy.");
    expect(
      getFailureCopy("Could not prepare the download sink.", "downloader")
        .heading,
    ).toBe("The save spot got messy.");
    expect(
      getFailureCopy(
        "File System Access is unavailable in this browser.",
        "downloader",
      ).heading,
    ).toBe("The save spot got messy.");
  });
});
