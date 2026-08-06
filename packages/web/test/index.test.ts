import { readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import { expect, test } from "vitest";

const indexPath = fileURLToPath(new URL("../index.html", import.meta.url));

test("index loads Umami with automatic pageviews disabled", () => {
  const indexHtml = readFileSync(indexPath, "utf8");
  const umamiScript =
    '<script defer src="https://stats.mayo.pizza/script.js" data-website-id="REPLACE_WITH_UMAMI_WEBSITE_ID" data-auto-track="false"></script>';

  expect(indexHtml).toContain(umamiScript);
  expect(indexHtml.indexOf(umamiScript)).toBeLessThan(
    indexHtml.indexOf('<script type="module" src="/src/main.tsx"></script>'),
  );
});
