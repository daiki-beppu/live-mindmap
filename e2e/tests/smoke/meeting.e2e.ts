import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { cli, e2eDir, readRunInfo, type RunInfo, run } from "../runInfo.ts";

// 会議中の流れ。smoke（target web、先頭 4 件）と全件（target web-full）の両方で同じ本文が動く。起動スクリプト（scripts/serve.ts）が立てた server・web に対して、CLI の start → 発言 → 字幕とノード → stop → 書き出し、を通す。
// 画面の判定と待ちは locator の expect だけで行う（agent.assert・waitFor・extract は使わない）。

const script = JSON.parse(readFileSync(join(e2eDir, "fixtures/meeting.json"), "utf8")) as { events: { type: string; track: string; text: string }[] };
const APP = "us.zoom.xos";
// smoke（target web）が台本から流す件数。e2e.config.ts の target と同じ
const SMOKE_EVENTS = 4;
// 反映までの待ち。locator の expect の timeout で待つ
const WAIT = { timeout: 30_000 };

// CLI を子プロセスで呼ぶ。ポートは一時的なものを環境変数で渡す
async function cliRun(runInfo: RunInfo, ...args: string[]) {
  const { stdout } = await run(process.execPath, [cli, ...args], {
    env: { ...process.env, LIVE_MINDMAP_CONFIG: join(runInfo.sessionsDir, "absent.config.json"), LIVE_MINDMAP_MODEL: "", LIVE_MINDMAP_PORT: String(runInfo.port), LIVE_MINDMAP_SESSIONS: runInfo.sessionsDir },
  });
  return stdout.split("\n").filter(Boolean);
}

test("会議中: start で届いた発言が字幕とノードになり、stop でエクスポートのファイルができる", async ({ app, agent, browser, screen }) => {
  await app.open("/");
  const runInfo = await readRunInfo(browser);
  const lastCaption = script.events[runInfo.events - 1]!;

  const [dir] = await cliRun(runInfo, "start", "--app", APP);

  // 途中結果は差分更新に渡らず、字幕に残る。確定した発言は呼び出し中でなければすぐ差分更新に渡り、反映すると字幕から消える
  // （偽の updater はすぐ返すので、字幕に見えるうちには捉えられない）。確定した発言は、ノード（文言は発言そのまま）になったことを確かめる
  const lastShown = lastCaption.type === "partial" ? browser.locator(".captions__bubble") : browser.locator(".map-node__text");
  await expect(lastShown.filter({ hasText: lastCaption.text })).toBeVisible(WAIT);

  // 字幕は話者つきの吹き出し（Issue #1022）。smoke の台本は、確定せずに残る 2 つの途中結果で終わる。
  // 相手の途中結果は左の行で、左の欄に仮のラベル（相手 B）か、約 3 秒たった後の「相手」だけが出る（遅い環境で 3 秒を超えても落ちないよう両方を許す。仮の濃さと 3 秒の規則は web の unit が確かめる）。自分の途中結果は右の行で、名前の欄は空
  if (runInfo.events === SMOKE_EVENTS) {
    const theirs = browser.locator(".captions__row").filter({ hasText: "検索の改善を先にやりた" });
    await expect(theirs).toHaveAttribute("class", /justify-start/);
    await expect(theirs.filter({ has: browser.locator(".captions__name").filter({ hasText: /^相手( B)?$/ }) })).toBeVisible();
    const mine = browser.locator(".captions__row").filter({ hasText: "担当を分け" });
    await expect(mine).toHaveAttribute("class", /justify-end/);
    // 名前の欄は 2 つ（行ごとに 1 つ）。文字が入っているのは相手の行だけで、自分の欄は空
    await expect(browser.locator(".captions__name")).toHaveCount(2);
    await expect(browser.locator(".captions__name").filter({ hasText: /\S/ })).toHaveCount(1);
  }

  // 全件の台本は、相手の発言「来週のリリースは」の後に、同じ区切りが「来週のリリースは金曜に」へ延びた途中結果で終わる（Issue #1222）。
  // 字幕には発言になった分を除いた「金曜に」だけが出て、発言になった「来週のリリースは」を含む吹き出しは出ない（発言はノードになる）
  if (runInfo.events === script.events.length) {
    await expect(browser.locator(".captions__bubble").filter({ hasText: "金曜に" })).toBeVisible(WAIT);
    await expect(browser.locator(".captions__bubble").filter({ hasText: "来週のリリースは" })).toHaveCount(0);
    await expect(browser.locator(".map-node__text").filter({ hasText: "来週のリリースは" })).toBeVisible(WAIT);
  }

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
    ["map.json", '"speaker": "相手 A"'],
    ["map.drawnix", '"type": "drawnix"'],
  ] as const;
  for (const [name, marker] of exported) {
    await app.open(`http://127.0.0.1:${runInfo.filesPort}/${basename(dir!)}/${name}`);
    await expect(browser.locator("pre")).toContainText(marker, WAIT);
  }
});
