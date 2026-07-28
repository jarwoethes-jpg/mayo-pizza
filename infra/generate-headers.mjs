import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readHeaderSource, renderCaddyHeaders } from "./header-source.mjs";

const defaultOutputPath = fileURLToPath(
  new URL("./security-headers.caddy", import.meta.url),
);

/**
 * Generates the Caddy security-header snippet from the canonical JSON source.
 *
 * @param {string} [outputPath]
 * @returns {string}
 */
export const generateHeaders = (outputPath = defaultOutputPath) => {
  const rendered = renderCaddyHeaders(readHeaderSource());
  writeFileSync(outputPath, rendered, "utf8");
  return rendered;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outputArgument = process.argv.indexOf("--output");
  const outputPath =
    outputArgument === -1
      ? defaultOutputPath
      : process.argv[outputArgument + 1];
  if (outputArgument !== -1 && outputPath === undefined) {
    throw new Error("--output requires a file path.");
  }
  generateHeaders(outputPath);
}
