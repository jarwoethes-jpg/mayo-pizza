import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
// @ts-expect-error -- plain-JS infra module shared with the Caddy generator; typed via JSDoc.
import { buildHeaders, toPreviewHeaders } from "../../infra/header-source.mjs";

// WHY compose here rather than read headers.json directly: the preview policy must come from
// the same core string and the same composer as the deployed Caddy snippet, so the CSP the
// e2e suite exercises cannot silently diverge from the one production serves.
const previewHeaders = toPreviewHeaders(buildHeaders("preview")) as Record<
  string,
  string
>;

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
