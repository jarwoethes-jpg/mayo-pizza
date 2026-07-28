import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const defaultHeadersPath = fileURLToPath(
  new URL("./headers.json", import.meta.url),
);

/** @typedef {Record<string, string | null>} HeaderSource */

/**
 * Reads the canonical header source.
 *
 * WHY: Caddy generation and tests must consume the same bytes as the deployed source.
 *
 * @param {string} [headersPath]
 * @returns {HeaderSource}
 */
export const readHeaderSource = (headersPath = defaultHeadersPath) =>
  /** @type {HeaderSource} */ (JSON.parse(readFileSync(headersPath, "utf8")));

/**
 * Converts the canonical source to Vite's response-header shape.
 *
 * WHY: null is the explicit source-level representation of Caddy's `-Server`
 * removal directive and must not become a response header in preview.
 *
 * @param {HeaderSource} headers
 * @returns {Record<string, string>}
 */
export const toPreviewHeaders = (headers) =>
  Object.fromEntries(
    Object.entries(headers).filter(([, value]) => typeof value === "string"),
  );

const quoteCaddyValue = (value) =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/**
 * Renders canonical headers as a Caddy `header` block.
 *
 * WHY tabs: `caddy fmt` normalises Caddyfile indentation to tabs, and Caddy logs a
 * "input is not formatted" warning on every validate/start otherwise.
 *
 * @param {HeaderSource} headers
 * @returns {string}
 */
export const renderCaddyHeaders = (headers) =>
  `header {\n${Object.entries(headers)
    .map(([name, value]) =>
      value === null ? `\t-${name}` : `\t${name} ${quoteCaddyValue(value)}`,
    )
    .join("\n")}\n}\n`;
