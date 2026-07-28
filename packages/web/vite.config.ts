import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

type HeaderSource = Record<string, string | null>;

const headersPath = fileURLToPath(
  new URL("../../infra/headers.json", import.meta.url),
);
const headerSource = JSON.parse(
  readFileSync(headersPath, "utf8"),
) as HeaderSource;
const previewHeaders = Object.fromEntries(
  Object.entries(headerSource).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  ),
) as Record<string, string>;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  preview: {
    headers: previewHeaders,
  },
  resolve: {
    alias: {
      shared: fileURLToPath(new URL("../shared/src", import.meta.url)),
    },
  },
});
