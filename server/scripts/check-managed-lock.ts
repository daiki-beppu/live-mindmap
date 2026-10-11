import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const content = readFileSync(join(root, "package.json"), "utf8");
const pkg = JSON.parse(content) as { devDependencies: Record<string, string> };
for (const [dependency, name] of [["chromium", "playwright-core"], ["claude", "@anthropic-ai/claude-agent-sdk"]] as const) {
  const lock = JSON.parse(readFileSync(join(root, "managed-deps", dependency, "package-lock.json"), "utf8")) as {
    packages: Record<string, { version?: string }>;
  };
  const fixed = lock.packages[`node_modules/${name}`]?.version;
  if (fixed === undefined || pkg.devDependencies[name] !== fixed) {
    const line = content.split("\n").findIndex((text) => text.includes(`"${name}"`)) + 1;
    console.error(`package.json:${Math.max(1, line)}: ${name} は同梱 lock の固定版 ${fixed} と一致させてください`);
    process.exitCode = 1;
  }
}
