import type { Page } from "@playwright/test";

/** The failure monitor handle used by long-running transfer gates. */
export interface TransferFailureMonitor {
  promise: Promise<never>;
  stop: () => void;
}

/** Fails a long-running browser gate as soon as either failure surface speaks. */
export const startTransferFailureMonitor = (
  page: Page,
): TransferFailureMonitor => {
  let active = true;
  let interval: ReturnType<typeof setInterval> | undefined;
  let rejectFailure: (reason: Error) => void = () => undefined;
  const promise = new Promise<never>((_, reject) => {
    rejectFailure = reject;
  });
  const stop = (): void => {
    active = false;
    if (interval !== undefined) {
      clearInterval(interval);
    }
  };
  const check = async (): Promise<void> => {
    if (!active) {
      return;
    }
    try {
      const [log, result] = await Promise.all([
        page.getByTestId("log").textContent({ timeout: 1_000 }),
        page.getByTestId("transfer-result").textContent({ timeout: 1_000 }),
      ]);
      const logText = log ?? "";
      const resultText = result ?? "";
      if (
        active &&
        (/fail|error|quota/i.test(logText) ||
          /Transfer result:\s*failed/i.test(resultText))
      ) {
        const error = new Error(`Transfer failed: ${resultText || logText}`);
        stop();
        rejectFailure(error);
      }
    } catch {
      // The page can be closing after the transfer result is observed.
    }
  };
  interval = setInterval(() => void check(), 500);
  void check();
  return { promise, stop };
};
