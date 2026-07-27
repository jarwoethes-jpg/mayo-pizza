import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { makeZip, predictLength } from "client-zip";
import { describe, expect, it, vi } from "vitest";
import type { FolderEntry } from "../src/folder/entries";
import { makeZipPlan } from "../src/folder/zipPlan";
import type {
  SenderWorkerCommand,
  SenderWorkerEvent,
} from "../src/worker/messages";

const entries: FolderEntry[] = [
  { path: "root/", file: undefined },
  { path: "root/empty/", file: undefined },
  { path: "root/naïve.txt", file: new File(["hello"], "naïve.txt") },
];

const readZip = async (): Promise<Uint8Array> => {
  const reader = makeZip(makeZipPlan(entries)).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) {
      break;
    }
    chunks.push(result.value);
    total += result.value.byteLength;
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
};

describe("sender worker ZIP source", () => {
  it("serves bounded demand-driven slices and re-seeds on resume", async () => {
    const previousSelf = globalThis.self;
    const events: SenderWorkerEvent[] = [];
    const scope = {
      onmessage: null as
        | ((event: MessageEvent<SenderWorkerCommand>) => void)
        | null,
      postMessage: vi.fn((event: SenderWorkerEvent) => events.push(event)),
    };
    Object.defineProperty(globalThis, "self", {
      configurable: true,
      value: scope,
    });

    try {
      await import("../src/worker/sender.worker.ts?sender-worker-test");
      const full = await readZip();
      const totalBytes = Number(predictLength(makeZipPlan(entries)));
      scope.onmessage?.({
        data: {
          t: "start",
          folder: {
            entries,
            directoryLastModified: Date.UTC(2020, 0, 1),
          },
          offset: 0,
          totalBytes,
        },
      } as MessageEvent<SenderWorkerCommand>);
      scope.onmessage?.({ data: { t: "read", offset: 0 } } as MessageEvent);
      await vi.waitFor(() =>
        expect(events.some((event) => event.t === "slice" && event.done)).toBe(
          true,
        ),
      );
      const firstRun = events.filter(
        (event): event is Extract<SenderWorkerEvent, { t: "slice" }> =>
          event.t === "slice",
      );
      expect(
        firstRun.every((event) => event.buffer.byteLength <= 4 * 1024 * 1024),
      ).toBe(true);
      expect(
        firstRun.reduce(
          (totalLength, event) => totalLength + event.buffer.byteLength,
          0,
        ),
      ).toBe(full.byteLength);

      events.length = 0;
      const offset = Math.min(13, full.byteLength - 1);
      scope.onmessage?.({ data: { t: "resume", offset } } as MessageEvent);
      await vi.waitFor(() =>
        expect(events).toContainEqual({ t: "resumed", offset }),
      );
      scope.onmessage?.({ data: { t: "read", offset } } as MessageEvent);
      await vi.waitFor(() =>
        expect(events.some((event) => event.t === "slice" && event.done)).toBe(
          true,
        ),
      );
      const resumed = events.find(
        (event): event is Extract<SenderWorkerEvent, { t: "slice" }> =>
          event.t === "slice",
      );
      if (resumed === undefined) {
        throw new Error("The worker did not return a resumed slice.");
      }
      expect(new Uint8Array(resumed.buffer)).toEqual(full.subarray(offset));
      expect(resumed.sha256).toBe(bytesToHex(sha256(full)));
    } finally {
      if (previousSelf === undefined) {
        Reflect.deleteProperty(globalThis, "self");
      } else {
        Object.defineProperty(globalThis, "self", {
          configurable: true,
          value: previousSelf,
        });
      }
    }
  });
});
