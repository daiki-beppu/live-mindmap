import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

// review と meeting の e2e が共有する、CLI の呼び出しと起動スクリプトの run-info の読み込み。
export const run = promisify(execFile);
export const e2eDir = join(import.meta.dirname, "..");
export const cli = join(e2eDir, "../server/src/cli.ts");
export type RunInfo = { port: number; sessionsDir: string; filesPort: number; events: number };

// 起動スクリプトが target ごとに `.run/<web のポート>.json` へ書く。server のポート、セッションのフォルダ（一時）、書き出しの配信ポート、台本から流す発言の件数。
// テストの収集時にはまだ無いので、アプリが立った後に、開いている画面のポートで読む
export const readRunInfo = async (browser: { url(): string | Promise<string> }) => {
  const webPort = new URL(await browser.url()).port;
  return JSON.parse(readFileSync(join(e2eDir, ".run", `${webPort}.json`), "utf8")) as RunInfo;
};
