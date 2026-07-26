import type { Sink } from "./index";

interface WritableFileStreamLike {
  write(data: BufferSource): Promise<void>;
  close(): Promise<void>;
  abort?(reason?: unknown): Promise<void>;
}

interface FileHandleLike {
  createWritable(): Promise<WritableFileStreamLike>;
}

interface FilePickerWindow extends Window {
  showSaveFilePicker?: (options?: {
    suggestedName?: string;
  }) => Promise<FileHandleLike>;
}

/** Creates the File System Access sink. The picker call must remain before any await. */
export const createFsaSink = (name: string): Promise<Sink> => {
  const picker = (window as FilePickerWindow).showSaveFilePicker;
  if (typeof picker !== "function") {
    throw new Error("File System Access is unavailable in this browser.");
  }

  // Keep this invocation synchronous so Chromium associates it with the click.
  const handlePromise = picker({ suggestedName: name });
  return handlePromise.then((handle) =>
    handle.createWritable().then((writer) => {
      let closed = false;
      return {
        strategy: "fsa" as const,
        write(bytes: Uint8Array): Promise<void> {
          if (closed) {
            throw new Error("The file sink is already closed.");
          }
          const buffer =
            bytes.byteOffset === 0 &&
            bytes.byteLength === bytes.buffer.byteLength
              ? (bytes.buffer as ArrayBuffer)
              : (bytes.slice().buffer as ArrayBuffer);
          return writer.write(buffer);
        },
        close(): Promise<void> {
          if (closed) {
            return Promise.resolve();
          }
          closed = true;
          return writer.close();
        },
        cancel(reason: string): Promise<void> {
          if (closed) {
            return Promise.resolve();
          }
          closed = true;
          return writer.abort?.(reason) ?? Promise.resolve();
        },
      } satisfies Sink;
    }),
  );
};
