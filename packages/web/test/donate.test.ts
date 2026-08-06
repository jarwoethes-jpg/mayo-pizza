import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { DONATE_URL, PrivacyPage } from "../src/ui/legal";

vi.mock("../src/styles.css", () => ({}));
vi.mock("react-dom/client", () => ({
  createRoot: () => ({ render: () => undefined }),
}));

const getDonateAttributes = (
  markup: string,
): { attributes: string; contents: string } => {
  const match = markup.match(
    /<a\b(?=[^>]*\bclass="kofi-button"[^>]*)([^>]*)>([\s\S]*?)<\/a>/,
  );
  if (match === null) {
    throw new Error("The rendered footer has no Ko-fi button anchor.");
  }
  return { attributes: match[1], contents: match[2] };
};

describe("donate footer links", () => {
  let RoomView: typeof import("../src/main").RoomView;

  beforeAll(async () => {
    globalThis.document = {
      getElementById: () => ({}),
    } as unknown as Document;
    ({ RoomView } = await import("../src/main"));
  });

  it("keeps both donate anchors external and safe", () => {
    const markups = [
      renderToStaticMarkup(createElement(RoomView, { role: "uploader" })),
      renderToStaticMarkup(createElement(PrivacyPage)),
    ];

    for (const markup of markups) {
      const { attributes, contents } = getDonateAttributes(markup);
      const href = attributes.match(/\bhref="([^"]*)"/)?.[1];
      const target = attributes.match(/\btarget="([^"]*)"/)?.[1];
      const rel = attributes.match(/\brel="([^"]*)"/)?.[1] ?? "";

      expect(href).toBe(DONATE_URL);
      expect(target).toBe("_blank");
      expect(rel).toContain("noopener");
      expect(rel).toContain("noreferrer");
      expect(contents).toMatch(
        /<img\b[^>]*\balt="Buy Me a Coffee at ko-fi\.com"[^>]*\/?\s*>/,
      );
    }
  });
});
