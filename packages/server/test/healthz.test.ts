import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/index.js";

const app = createApp();
const staticIndex = fileURLToPath(
  new URL("../../web/dist/index.html", import.meta.url),
);

afterAll(async () => {
  await app.close();
});

describe("GET /healthz", () => {
  it("returns the service health payload", async () => {
    const response = await app.inject({ method: "GET", url: "/healthz" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });

  it.skipIf(!existsSync(staticIndex))(
    "serves the built web index",
    async () => {
      const response = await app.inject({ method: "GET", url: "/" });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("mayo.pizza");
    },
  );
});
