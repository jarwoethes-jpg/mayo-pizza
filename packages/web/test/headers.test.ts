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
  const { readHeaderSource, toPreviewHeaders } = await import(
    "../../../infra/header-source.mjs"
  );
  const source = readHeaderSource(headersPath);
  const previewHeaders = toPreviewHeaders(source);

  expect(previewHeaders).not.toHaveProperty("Server");
  expect(previewHeaders["Content-Security-Policy"]).toContain(
    "script-src 'self'",
  );
  expect(Object.keys(previewHeaders)).toHaveLength(
    Object.keys(source).length - 1,
  );
});
