import { describe, expect, it, vi } from "vitest";
import { createShutdownHandler } from "../src/index.js";

describe("createShutdownHandler", () => {
  it("closes the server and then exits", async () => {
    const closed: string[] = [];
    const close = vi.fn(async () => {
      closed.push("closed");
    });
    const exit = vi.fn(() => {
      closed.push("exited");
    });

    createShutdownHandler(close, exit)();
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledTimes(1);
    });
    // WHY: the metrics flush lives in Fastify's onClose hook, so exiting before
    // close() resolves would drop the very counters this handler exists to save.
    expect(closed).toEqual(["closed", "exited"]);
  });

  it("closes once when several signals arrive", async () => {
    const close = vi.fn(async () => undefined);
    const exit = vi.fn();

    const handler = createShutdownHandler(close, exit);
    handler();
    handler();
    handler();

    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledTimes(1);
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("still exits when closing fails", async () => {
    const close = vi.fn(async () => {
      throw new Error("close failed");
    });
    const exit = vi.fn();

    createShutdownHandler(close, exit)();

    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledTimes(1);
    });
  });
});
