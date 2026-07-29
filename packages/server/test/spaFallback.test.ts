import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/index.js";

const temporaryRoots: string[] = [];

const createWebRoot = (indexHtml?: string): string => {
  const root = mkdtempSync(join(tmpdir(), "mayo-pizza-spa-"));
  temporaryRoots.push(root);
  if (indexHtml !== undefined) {
    writeFileSync(join(root, "index.html"), indexHtml);
  }
  return root;
};

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("SPA fallback", () => {
  it("serves index.html for an HTML room request", async () => {
    const indexHtml = "<!doctype html><html><body>minimal spa</body></html>";
    const app = createApp({ webRoot: createWebRoot(indexHtml) });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/some-random-slug",
        headers: { accept: "text/html" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/html");
      expect(response.body).toBe(indexHtml);
    } finally {
      await app.close();
    }
  });

  it("returns Fastify's default 404 shape without an HTML Accept header", async () => {
    const app = createApp({ webRoot: createWebRoot("index") });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/some-random-slug",
        headers: { accept: "application/json" },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({
        message: "Route GET:/some-random-slug not found",
        error: "Not Found",
        statusCode: 404,
      });
    } finally {
      await app.close();
    }
  });

  it("falls back to index.html for a missing asset with an HTML Accept header", async () => {
    const indexHtml = "<!doctype html><html>asset fallback</html>";
    const app = createApp({ webRoot: createWebRoot(indexHtml) });

    try {
      // @fastify/static calls the not-found handler for missing files, so this implementation falls back for HTML requests.
      const response = await app.inject({
        method: "GET",
        url: "/nonexistent-asset.js",
        headers: { accept: "text/html" },
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toBe(indexHtml);
    } finally {
      await app.close();
    }
  });

  it("keeps the health endpoint registered", async () => {
    const app = createApp({ webRoot: createWebRoot("index") });

    try {
      const response = await app.inject({ method: "GET", url: "/healthz" });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ok: true });
    } finally {
      await app.close();
    }
  });

  it("does not install a fallback when index.html is absent", async () => {
    const app = createApp({ webRoot: createWebRoot() });

    try {
      const response = await app.inject({
        method: "GET",
        url: "/some-slug",
        headers: { accept: "text/html" },
      });

      expect(response.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
