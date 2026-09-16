import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { BLOB_MAX_BYTES, getBlobTooLargeMessage } from "../src/sink";

const harness = vi.hoisted(() => ({
  blobLimitBytes: 500 * 1024 * 1024,
  pendingManifest: {
    t: "manifest" as const,
    transferId: "large-slice",
    mode: "single" as const,
    items: [
      { path: "large.bin", size: 500 * 1024 * 1024 + 1, lastModified: 0 },
    ],
    totalBytes: 500 * 1024 * 1024 + 1,
    suggestedName: "large.bin",
  },
  sessionNotice: undefined as string | undefined,
  stateIndex: 0,
}));

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    useEffect: (_effect: () => unknown): void => {},
    useReducer: <State>(_reducer: unknown, initialState: State) => [
      initialState,
      (): void => {},
    ],
    useRef: <Value>(initialValue: Value) => ({ current: initialValue }),
    useState: <State>(initialState: State) => {
      const stateIndex = harness.stateIndex;
      harness.stateIndex += 1;
      if (stateIndex === 16) {
        return [harness.pendingManifest as State, (): void => {}];
      }
      if (stateIndex === 22) {
        return [harness.sessionNotice as State, (): void => {}];
      }
      return [initialState, (): void => {}];
    },
  };
});

vi.mock("react-dom/client", () => ({
  createRoot: () => ({ render: () => undefined }),
}));
vi.mock("../src/styles.css", () => ({}));

describe("receiver accept presentation", () => {
  let RoomView: typeof import("../src/main").RoomView;

  beforeAll(async () => {
    vi.stubGlobal("document", { getElementById: vi.fn(() => ({})) });
    vi.stubGlobal("window", {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      location: {
        origin: "https://mayo.test",
        host: "mayo.test",
        protocol: "https:",
      },
    });
    ({ RoomView } = await import("../src/main"));
  });

  beforeEach(() => {
    harness.stateIndex = 0;
    harness.pendingManifest = {
      t: "manifest",
      transferId: "large-slice",
      mode: "single",
      items: [
        {
          path: "large.bin",
          size: harness.blobLimitBytes + 1,
          lastModified: 0,
        },
      ],
      totalBytes: harness.blobLimitBytes + 1,
      suggestedName: "large.bin",
    };
    harness.sessionNotice = undefined;
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("warns before acceptance and disables an oversized blob download", () => {
    const markup = renderToStaticMarkup(
      createElement(RoomView, { role: "downloader", slug: "room" }),
    );

    expect(markup).toContain('data-testid="manifest-limit-warning"');
    expect(markup).toContain(
      getBlobTooLargeMessage(BLOB_MAX_BYTES).replaceAll("'", "&#x27;"),
    );
    expect(markup).toMatch(
      /data-testid="accept-transfer"[^>]*disabled(?:="")?/,
    );
    expect(markup).toContain("Unavailable in this browser");
    expect(markup).not.toContain(
      "A fresh slice just landed. Check the details, then grab it when you’re ready.",
    );
  });

  it("keeps an accept failure visible over the fresh-manifest copy", () => {
    harness.pendingManifest = {
      t: "manifest",
      transferId: "retryable-slice",
      mode: "single",
      items: [{ path: "file.bin", size: 1, lastModified: 0 }],
      totalBytes: 1,
      suggestedName: "file.bin",
    };
    harness.sessionNotice =
      "Slice dropped! Your download spot got a little messy. Choose a fresh save spot and we’ll give it another go.";

    const markup = renderToStaticMarkup(
      createElement(RoomView, { role: "downloader", slug: "room" }),
    );

    expect(markup).toContain(harness.sessionNotice);
    expect(markup).not.toContain(
      "A fresh slice just landed. Check the details, then grab it when you’re ready.",
    );
  });
});
