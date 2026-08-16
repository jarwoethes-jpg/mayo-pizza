import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { expect, test } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const robotsPath = join(repositoryRoot, "packages/web/public/robots.txt");
const caddyfilePath = join(repositoryRoot, "infra/Caddyfile");

type RobotsRule = { directive: "Allow" | "Disallow"; path: string };

const parseRobots = (content: string): RobotsRule[] =>
  content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .filter((line) => line.startsWith("Allow:") || line.startsWith("Disallow:"))
    .map((line) => {
      const colon = line.indexOf(":");
      return {
        directive: line.slice(0, colon).trim() as "Allow" | "Disallow",
        path: line.slice(colon + 1).trim(),
      };
    });

// Implements the robots.txt matching rules: prefix match, `$` end anchor,
// longest (most specific) match wins, Allow wins a tie.
const isAllowed = (rules: RobotsRule[], path: string): boolean => {
  let best: { rule: RobotsRule; specificity: number } | null = null;
  for (const rule of rules) {
    const anchored = rule.path.endsWith("$");
    const prefix = anchored ? rule.path.slice(0, -1) : rule.path;
    const matches = anchored ? path === prefix : path.startsWith(prefix);
    if (!matches) continue;
    if (best === null || prefix.length > best.specificity) {
      best = { rule, specificity: prefix.length };
    } else if (prefix.length === best.specificity && rule.directive === "Allow") {
      best = { rule, specificity: prefix.length };
    }
  }
  return best === null || best.rule.directive === "Allow";
};

test("robots.txt allows only the marketing surface and disallows room slugs", () => {
  const rules = parseRobots(readFileSync(robotsPath, "utf8"));

  // Marketing surface and the static assets needed to render it are crawlable.
  expect(isAllowed(rules, "/")).toBe(true);
  expect(isAllowed(rules, "/privacy")).toBe(true);
  expect(isAllowed(rules, "/terms")).toBe(true);
  expect(isAllowed(rules, "/brand/logo-mark.svg")).toBe(true);
  expect(isAllowed(rules, "/assets/app.js")).toBe(true);
  expect(isAllowed(rules, "/fonts/rubik-latin.woff2")).toBe(true);
  expect(isAllowed(rules, "/robots.txt")).toBe(true);

  // Room slugs and every other path stay disallowed.
  expect(isAllowed(rules, "/SUPERSECRETSLUG42")).toBe(false);
  expect(isAllowed(rules, "/some-room")).toBe(false);
  expect(isAllowed(rules, "/privacyfoo")).toBe(false);
  expect(isAllowed(rules, "/terms/extra")).toBe(false);
  expect(isAllowed(rules, "/brand")).toBe(false);
});

test("the Caddyfile indexable matcher is exact-path, never a bare path / prefix", () => {
  const caddyfile = readFileSync(caddyfilePath, "utf8");

  const matcher = caddyfile.match(/@indexable\s+([^\n]+)/);
  expect(matcher).not.toBeNull();
  const matcherLine = matcher![1].trim();

  // A bare `path /` token is a prefix match on every URL and would index room slugs.
  expect(matcherLine).not.toMatch(/path\s+\/(?:\s|$)/);

  // The matcher must be an anchored exact-path matcher.
  expect(matcherLine).toMatch(/^path_regexp\s+\^.*\$$/);

  // The header removal must target the matcher.
  expect(caddyfile).toMatch(/header\s+@indexable\s+-X-Robots-Tag/);
});
