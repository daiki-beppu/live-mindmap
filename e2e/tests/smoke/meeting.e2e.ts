import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";

// 会議中の流れ。smoke（target web、先頭 3 件）と全件（target web-full）の両方で同じ本文が動く。起動スクリプト（scripts/serve.ts）が立てた server・web に対して、CLI の start → 発言 → 字幕とノード → stop → 書き出し、を通す。
// 画面の判定と待ちは locator の expect だけで行う（agent.assert・waitFor・extract は使わない）。

const run = promisify(execFile);
const e2eDir = join(import.meta.dirname, "../..");
const cli = join(e2eDir, "../server/src/cli.ts");
const script = JSON.parse(readFileSync(join(e2eDir, "fixtures/meeting.json"), "utf8")) as { events: { type: string; track: string; text: string }[] };
type RunInfo = { port: number; sessionsDir: string; filesPort: number; events: number };
// 起動スクリプトが target ごとに `.run/<web のポート>.json` へ書く。server のポート、セッションのフォルダ（一時）、書き出しの配信ポート、台本から流す発言の件数。
// テストの収集時にはまだ無いので、アプリが立った後に、開いている画面のポートで読む
const readRunInfo = async (browser: { url(): string | Promise<string> }) => {
  const webPort = new URL(await browser.url()).port;
  return JSON.parse(readFileSync(join(e2eDir, ".run", `${webPort}.json`), "utf8")) as RunInfo;
};
const APP = "us.zoom.xos";
// 反映までの待ち。locator の expect の timeout で待つ
const WAIT = { timeout: 30_000 };

// CLI を子プロセスで呼ぶ。ポートは一時的なものを環境変数で渡す
async function cliRun(runInfo: RunInfo, ...args: string[]) {
  const { stdout } = await run(process.execPath, [cli, ...args], {
    env: { ...process.env, LIVE_MINDMAP_PORT: String(runInfo.port), LIVE_MINDMAP_SESSIONS: runInfo.sessionsDir },
  });
  return stdout.split("\n").filter(Boolean);
}

test("会議中: start で届いた発言が字幕とノードになり、stop でエクスポートのファイルができる", async ({ app, agent, browser, screen }) => {
  await app.open("/");
  const runInfo = await readRunInfo(browser);
  const lastCaption = script.events[runInfo.events - 1]!;

  const [dir] = await cliRun(runInfo, "start", "--app", APP);

  await expect(browser.locator(".captions__line").filter({ hasText: lastCaption.text })).toBeVisible(WAIT);
  const nodes = screen.getByRole("button", { pressed: false }).filter({ has: browser.locator(".map-node__text") });
  await expect(nodes.first()).toBeVisible(WAIT);

  await agent.act("マップのノードを 1 つ選ぶ");
  await expect(screen.getByRole("button", { pressed: true }).first()).toHaveAttribute("aria-pressed", "true");

  await cliRun(runInfo, "stop");
  // 書き出しのファイルは、起動スクリプトが配信するセッションのフォルダ（一時）から開き、本文を locator で確かめる。
  // 見るのはファイルができていることと、その形式の構造だけ。ノードの文言や種類は見ない。ファイルが無ければ本文なしの 404 になり、目印が出ず不合格になる
  const exported = [
    ["map.md", "## アウトライン"],
    ["map.json", '"root"'],
    ["map.drawnix", '"type": "drawnix"'],
  ] as const;
  for (const [name, marker] of exported) {
    await app.open(`http://127.0.0.1:${runInfo.filesPort}/${basename(dir!)}/${name}`);
    await expect(browser.locator("pre")).toContainText(marker, WAIT);
  }
});
