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
 * Extra `connect-src` origins each environment needs on top of the core policy.
 *
 * WHY: the signalling socket is a different origin from the page in preview (the app is
 * served on :5173 and signals on :3100), so `'self'` cannot cover it. Production must NOT
 * inherit that localhost entry, hence the split — but both policies are still composed from
 * one core string by one function, so they cannot drift apart independently.
 *
 * @type {Record<"production" | "preview", readonly string[]>}
 */
export const CONNECT_SRC_EXTRAS = {
  production: ["wss://mayo.pizza"],
  preview: ["ws://127.0.0.1:3100"],
};

/**
 * Appends origins to the `connect-src` directive of a policy string.
 *
 * @param {string} policy
 * @param {readonly string[]} origins
 * @returns {string}
 */
const appendConnectSrc = (policy, origins) => {
  if (origins.length === 0) {
    return policy;
  }
  const directive = /connect-src ([^;]*)/;
  if (!directive.test(policy)) {
    throw new Error("The core CSP has no connect-src directive to extend.");
  }
  return policy.replace(
    directive,
    (_match, sources) => `connect-src ${sources.trim()} ${origins.join(" ")}`,
  );
};

/**
 * Composes the canonical header set for one environment.
 *
 * @param {"production" | "preview"} environment
 * @param {HeaderSource} [headers]
 * @returns {HeaderSource}
 */
export const buildHeaders = (environment, headers = readHeaderSource()) => {
  const extras = CONNECT_SRC_EXTRAS[environment];
  if (extras === undefined) {
    throw new Error(`Unknown header environment: ${environment}`);
  }
  const policy = headers["Content-Security-Policy"];
  if (typeof policy !== "string") {
    throw new Error("The canonical header source has no CSP string.");
  }
  return {
    ...headers,
    "Content-Security-Policy": appendConnectSrc(policy, extras),
  };
};

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
