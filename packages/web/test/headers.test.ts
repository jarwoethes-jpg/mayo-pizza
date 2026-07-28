import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { expect, test } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const headersPath = join(repositoryRoot, "infra/headers.json");
const committedSnippetPath = join(
  repositoryRoot,
  "infra/security-headers.caddy",
);

test("the generated Caddy snippet stays byte-identical to the committed snippet", async () => {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "mayo-headers-"));
  const generatedPath = join(temporaryDirectory, "security-headers.caddy");
  try {
    const { generateHeaders } = await import(
      "../../../infra/generate-headers.mjs"
    );
    generateHeaders(generatedPath);
    expect(readFileSync(generatedPath)).toEqual(
      readFileSync(committedSnippetPath),
    );
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test("the preview header source excludes only the Caddy removal entry", async () => {
  const { readHeaderSource, buildHeaders, toPreviewHeaders } = await import(
    "../../../infra/header-source.mjs"
  );
  const source = readHeaderSource(headersPath);
  const previewHeaders = toPreviewHeaders(buildHeaders("preview", source));

  expect(previewHeaders).not.toHaveProperty("Server");
  expect(previewHeaders["Content-Security-Policy"]).toContain(
    "script-src 'self'",
  );
  expect(Object.keys(previewHeaders)).toHaveLength(
    Object.keys(source).length - 1,
  );
});

// The whole point of splitting the policy: production must never advertise the localhost
// signalling origin the preview gate needs. A regression here ships a policy that permits
// connections to a port on the visitor's own machine.
test("the production policy carries no localhost signalling origin", async () => {
  const { buildHeaders } = await import("../../../infra/header-source.mjs");
  const production = buildHeaders("production");
  const policy = production["Content-Security-Policy"];

  expect(policy).not.toContain("127.0.0.1");
  expect(policy).not.toContain("localhost");
  expect(policy).toContain("connect-src 'self' wss://mayo.pizza");
});

test("the preview policy grants exactly the signalling origin the e2e suite uses", async () => {
  const { buildHeaders } = await import("../../../infra/header-source.mjs");
  const preview = buildHeaders("preview");
  const policy = preview["Content-Security-Policy"];

  expect(policy).toContain("connect-src 'self' ws://127.0.0.1:3100");
  // Production-only origins must not leak the other way either.
  expect(policy).not.toContain("wss://mayo.pizza");
});

test("both environments share every directive other than connect-src", async () => {
  const { buildHeaders } = await import("../../../infra/header-source.mjs");
  const stripConnectSrc = (policy: string): string[] =>
    policy
      .split(";")
      .map((directive) => directive.trim())
      .filter((directive) => !directive.startsWith("connect-src"));

  const production = buildHeaders("production")[
    "Content-Security-Policy"
  ] as string;
  const preview = buildHeaders("preview")["Content-Security-Policy"] as string;

  expect(stripConnectSrc(preview)).toEqual(stripConnectSrc(production));
});
