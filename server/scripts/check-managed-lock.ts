import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const content = readFileSync(join(root, "package.json"), "utf8");
const pkg = JSON.parse(content) as { devDependencies: Record<string, string> };
const lock = JSON.parse(readFileSync(join(root, "managed-deps/chromium/package-lock.json"), "utf8")) as {
  packages: Record<string, { version?: string }>;
};
const fixed = lock.packages["node_modules/playwright-core"]?.version;
if (fixed === undefined || pkg.devDependencies["playwright-core"] !== fixed) {
  const line = content.split("\n").findIndex((text) => text.includes('"playwright-core"')) + 1;
  console.error(`package.json:${Math.max(1, line)}: playwright-core は同梱 lock の固定版 ${fixed} と一致させてください`);
  process.exitCode = 1;
}
