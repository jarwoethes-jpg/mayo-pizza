import { createBlobSink } from "./blob";
import { createFsaSink } from "./fsa";
import { createSwSink } from "./swStream";

export type SinkStrategy = "fsa" | "sw" | "blob" | "null";

export interface Sink {
  readonly strategy: SinkStrategy;
  write(bytes: Uint8Array): Promise<void> | void;
  close(): Promise<void> | void;
  cancel(reason: string): Promise<void> | void;
  isResponsive?(): boolean;
}

export type SinkFactory = (
  name: string,
  totalBytes: number,
) => Sink | Promise<Sink>;

export interface SinkOverride {
  strategy?: SinkStrategy;
  factory?: SinkFactory;
  autoAccept?: boolean;
}

const sinkStrategies: readonly SinkStrategy[] = ["fsa", "sw", "blob", "null"];

const isSinkStrategy = (value: unknown): value is SinkStrategy =>
  typeof value === "string" && sinkStrategies.includes(value as SinkStrategy);

const readOverrideValue = (): unknown =>
  typeof window === "undefined"
    ? undefined
    : (window.__MAYO_SINK__ ?? window.__MAYO_SINK_STRATEGY__);

const normalizeOverride = (value: unknown): SinkOverride | undefined => {
  if (isSinkStrategy(value)) {
    return { strategy: value };
  }
  if (typeof value === "function") {
    return { factory: value as SinkFactory };
  }
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const candidate = value as {
    strategy?: unknown;
    factory?: unknown;
    create?: unknown;
    autoAccept?: unknown;
  };
  const strategy = isSinkStrategy(candidate.strategy)
    ? candidate.strategy
    : undefined;
  const factory =
    typeof candidate.factory === "function"
      ? (candidate.factory as SinkFactory)
      : typeof candidate.create === "function"
        ? (candidate.create as SinkFactory)
        : undefined;
  if (strategy === undefined && factory === undefined) {
    return undefined;
  }
  return {
    ...(strategy === undefined ? {} : { strategy }),
    ...(factory === undefined ? {} : { factory }),
    ...(typeof candidate.autoAccept === "boolean"
      ? { autoAccept: candidate.autoAccept }
      : {}),
  };
};

interface SinkFeatureEnvironment {
  showSaveFilePicker?: unknown;
  serviceWorker?: unknown;
}

const browserSinkFeatures = (): SinkFeatureEnvironment => ({
  showSaveFilePicker:
    typeof window === "undefined"
      ? undefined
      : (window as Window & { showSaveFilePicker?: unknown })
          .showSaveFilePicker,
  serviceWorker:
    typeof navigator === "undefined" ? undefined : navigator.serviceWorker,
});

/** Detects the best native sink without invoking a permission prompt. */
export const detectSinkStrategy = (
  environment: SinkFeatureEnvironment = browserSinkFeatures(),
): SinkStrategy => {
  if (typeof environment.showSaveFilePicker === "function") {
    return "fsa";
  }
  if (
    environment.serviceWorker !== undefined &&
    typeof ReadableStream === "function"
  ) {
    return "sw";
  }
  return "blob";
};

const detectedStrategy = detectSinkStrategy();
const configuredOverride = normalizeOverride(readOverrideValue());
const selectedStrategy = configuredOverride?.strategy ?? detectedStrategy;

export const getDetectedSinkStrategy = (): SinkStrategy => detectedStrategy;

/** Returns the load-time selection, including an explicitly injected test strategy. */
export const getSinkStrategy = (): SinkStrategy => selectedStrategy;

export const getSinkOverride = (): SinkOverride | undefined =>
  configuredOverride;

class NullSink implements Sink {
  public readonly strategy = "null" as const;
  public write(_bytes: Uint8Array): void {}
  public close(): void {}
  public cancel(_reason: string): void {}
}

/** Creates the selected main-thread sink. FSA and SW setup starts synchronously. */
export const createSink = (
  name: string,
  totalBytes: number,
  factory?: SinkFactory,
): Sink | Promise<Sink> => {
  const overrideFactory = configuredOverride?.factory;
  if (factory !== undefined) {
    return factory(name, totalBytes);
  }
  if (overrideFactory !== undefined) {
    return overrideFactory(name, totalBytes);
  }
  if (selectedStrategy === "fsa") {
    return createFsaSink(name);
  }
  if (selectedStrategy === "sw") {
    return createSwSink(name, totalBytes);
  }
  if (selectedStrategy === "blob") {
    return createBlobSink(name, totalBytes);
  }
  return new NullSink();
};

export {
  BLOB_MAX_BYTES,
  BLOB_MAX_BYTES_IOS,
  blobMaxBytes,
  createBlobSink,
} from "./blob";
export {
  SINK_QUEUE_HIGH_WATERMARK,
  SINK_STALL_ABORT_MS,
  SINK_STALL_NOTICE_MS,
  SINK_START_TIMEOUT_MS,
  SinkManager,
  type SinkManagerOptions,
  type SinkStall,
} from "./manager";
export {
  consumeSwCredit,
  createSwCreditState,
  isNextSwSequence,
  releaseSwCredit,
  SW_CREDIT_BYTES,
  SwStreamSink,
} from "./swStream";
export { SINK_PROGRESS_WATCHDOG_MS } from "./watchdog";
