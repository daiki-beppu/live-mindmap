import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";

// 見返しの流れ。会議中の流れの出力には頼らず、手書きの log.jsonl（録音なし）だけから CLI の review で map.html を作り、ブラウザで開く。
// 時刻はシークバーで動かし、前後で画面のノードの数が変わることを locator の expect で確かめる（agent.assert・waitFor・extract は使わない）。
// 起動スクリプト（scripts/serve.ts）の配信が、拡張子 .html を text/html で返す前提。web / web-full の両方の target で動く。

const run = promisify(execFile);
const e2eDir = join(import.meta.dirname, "../..");
const cli = join(e2eDir, "../server/src/cli.ts");
type RunInfo = { port: number; sessionsDir: string; filesPort: number; events: number };
const readRunInfo = async (browser: { url(): string | Promise<string> }) => {
  const webPort = new URL(await browser.url()).port;
  return JSON.parse(readFileSync(join(e2eDir, ".run", `${webPort}.json`), "utf8")) as RunInfo;
};
const WAIT = { timeout: 30_000 };
// fixtures/review.log.jsonl のノード: ルート 1 + diff 3 回で足した 3
const ALL_NODES = 4;
const ROOT_ONLY = 1;

test("見返し: 時刻を先頭へ動かすと、終わりで揃っていたノードがルートだけに減る", async ({ app, agent, browser, screen }) => {
  await app.open("/");
  const { sessionsDir } = await readRunInfo(browser);

  // セッションのフォルダ名は server の ISO 時刻と重ならない固定名。録音は置かない（map.html だけができる）
  const dir = join(sessionsDir, "review");
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(e2eDir, "fixtures/review.log.jsonl"), join(dir, "log.jsonl"));
  await run(process.execPath, [cli, "review", dir], { timeout: 120_000 });

  await app.open("/session-files/review/map.html");
  const nodes = browser.locator(".map-node__text");
  await expect(screen.getByRole("slider", { name: "時刻" })).toBeVisible(WAIT);
  await expect(nodes).toHaveCount(ALL_NODES, WAIT);

  await agent.act("「時刻」のスライダー（slider）をクリックしてフォーカスし、Home キーを押して先頭（0:00:00）へ動かす。「反映 1 つ戻る」などのボタンは使わない");
  await expect(nodes).toHaveCount(ROOT_ONLY, WAIT);
});
