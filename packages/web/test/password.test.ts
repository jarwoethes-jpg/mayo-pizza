import { describe, expect, it } from "vitest";
import { PRIVACY_COPY } from "../src/ui/legal";
import {
  getPasswordPromptCopy,
  type PasswordPromptState,
  passwordPromptReducer,
} from "../src/ui/password";
import { makeRoomShareUrl, normalizeRoomPassword } from "../src/ui/room";
import { ABUSE_CONTACT, TERMS_COPY } from "../src/ui/terms";

describe("password room UX helpers", () => {
  it("keeps the prompt states explicit and copyable", () => {
    const required = passwordPromptReducer(undefined, { type: "required" });
    const wrong = passwordPromptReducer(required, {
      type: "wrong",
      attemptsRemaining: 4,
    });
    const locked = passwordPromptReducer(wrong, { type: "locked" });

    expect(required?.view).toBe("password-required");
    expect(wrong).toEqual({ view: "password-wrong", attemptsRemaining: 4 });
    expect(locked?.view).toBe("password-locked");
    expect(
      getPasswordPromptCopy(required as PasswordPromptState).heading,
    ).toMatch(/password/i);
    expect(getPasswordPromptCopy(wrong).message).toContain("4");
    expect(
      getPasswordPromptCopy({ view: "password-wrong" }).message,
    ).not.toMatch(/\d+\s+(tries|attempts)/i);
    expect(getPasswordPromptCopy(locked).message).toMatch(/fresh room/i);
  });

  it("does not create a protected room for blank drafts", () => {
    expect(normalizeRoomPassword("")).toBeUndefined();
    expect(normalizeRoomPassword("   \t")).toBeUndefined();
    expect(normalizeRoomPassword("  crisp crust  ")).toBe("crisp crust");
  });

  it("keeps passwords out of share URLs", () => {
    const shareUrl = makeRoomShareUrl("https://mayo.test", "room-slug");
    const parsed = new URL(shareUrl);

    expect(parsed.pathname).toBe("/room-slug");
    expect(parsed.searchParams.has("password")).toBe(false);
  });

  it("keeps the privacy and terms promises in the page copy", () => {
    const privacy = PRIVACY_COPY.join(" ");
    const terms = TERMS_COPY.join(" ");

    expect(privacy).toMatch(/peer-to-peer.*never touch/i);
    expect(privacy).toMatch(/coturn/i);
    expect(privacy).toMatch(/7 days/);
    expect(privacy).toMatch(/30 idle minutes/);
    expect(terms).toMatch(/lawful|illegal/i);
    expect(terms).toMatch(/relay/i);
    expect(terms).toMatch(/as-is/i);
    expect(ABUSE_CONTACT).toMatch(/^\[Mayo:/);
  });
});
