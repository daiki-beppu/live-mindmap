import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

export const run = promisify(execFile);
export const e2eDir = join(import.meta.dirname, "..");
export const cli = join(e2eDir, "../server/src/cli.ts");
export type RunInfo = { port: number; sessionsDir: string; filesPort: number; events: number };

export const readRunInfo = async (browser: { url(): string | Promise<string> }) => {
  const webPort = new URL(await browser.url()).port;
  return JSON.parse(readFileSync(join(e2eDir, ".run", `${webPort}.json`), "utf8")) as RunInfo;
};
