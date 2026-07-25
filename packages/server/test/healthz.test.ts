import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/index.js";

const app = createApp();

afterAll(async () => {
  await app.close();
});

describe("GET /healthz", () => {
  it("returns the service health payload", async () => {
    const response = await app.inject({ method: "GET", url: "/healthz" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
  });
});
