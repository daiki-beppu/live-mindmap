import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test, type Browser } from "@e2e-dev/web";
import { expect } from "e2e";
import { cli, e2eDir, readRunInfo, run } from "../runInfo.ts";

// 見返しの流れ。会議中の流れの出力には頼らず、手書きの log.jsonl（録音なし）だけから CLI の review で map.html を作り、ブラウザで開く。
// 時刻はシークバーで動かし、前後で画面のノードの数が変わることを locator の expect で確かめる（agent.assert・waitFor・extract は使わない）。
// 起動スクリプト（scripts/serve.ts）の配信が、拡張子 .html を text/html で返す前提。web / web-full の両方の target で動く。

const WAIT = { timeout: 30_000 };
// fixtures/review.log.jsonl のノード: ルート 1 + diff 3 回で足した 3
const ALL_NODES = 4;
const ROOT_ONLY = 1;

// fixture を <sessionsDir>/<name>/log.jsonl に置き、CLI の review で map.html を作って開く。
// セッションのフォルダ名は server の ISO 時刻と重ならない固定名。録音は置かない（map.html だけができる）
async function openReview({ app, browser }: { app: { open(path: string): Promise<unknown> }; browser: Browser }, name: string): Promise<void> {
  await app.open("/");
  const { sessionsDir } = await readRunInfo(browser);
  const dir = join(sessionsDir, name);
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(e2eDir, "fixtures/review.log.jsonl"), join(dir, "log.jsonl"));
  await run(process.execPath, [cli, "review", dir], { timeout: 120_000 });
  await app.open(`/session-files/${name}/map.html`);
}

test("見返し: 時刻を先頭へ動かすと、終わりで揃っていたノードがルートだけに減る", async ({ app, agent, browser, screen }) => {
  await openReview({ app, browser }, "review");
  const nodes = browser.locator(".map-node__text");
  await expect(screen.getByRole("slider", { name: "時刻" })).toBeVisible(WAIT);
  await expect(nodes).toHaveCount(ALL_NODES, WAIT);

  await agent.act("「時刻」のスライダー（slider）をクリックしてフォーカスし、Home キーを押して先頭（0:00:00）へ動かす。「反映 1 つ戻る」などのボタンは使わない");
  await expect(nodes).toHaveCount(ROOT_ONLY, WAIT);
});

// 速さのメニュー（Issue #1225）: メニューがボタンの位置に出ず、外側（backdrop）だけが画面にかぶさると、項目もほかのボタンも押せなくなる。
// 項目とボタンは locator の tap で押す（tap は、押す点で一番上に来るのがその要素であることまで確かめる）。位置と高さの数値は web の heavy IT（review.mount.heavy.test.ts）が見る。
// 録音なしの速さは 10・30・60・120 倍（最初は 30 倍）。PC の幅とスマホの幅（390×844）で同じ手順を流す。agent は使わない（replay cache は要らない）。
// スマホの幅で開くと字幕と右の列を隠して始める（Issue #1236 の一部）ので、ボタンは押していない状態から始まり、1 回押すと出る
test("見返し: 速さのメニューから速さを選べ、閉じた後は字幕・右の列のボタンが効く。スマホの幅では字幕と右の列を隠して始める", async ({ app, browser, screen }) => {
  // startsHidden: その幅で開いたときに、字幕と右の列を隠して始めるか
  for (const { viewport, startsHidden } of [{ viewport: { width: 1280, height: 720 }, startsHidden: false }, { viewport: { width: 390, height: 844 }, startsHidden: true }]) {
    // 開いたときに出ているか（aria-pressed）と、1 回押した後
    const [before, after] = startsHidden ? ["false", "true"] : ["true", "false"];
    await browser.setViewport(viewport);
    await openReview({ app, browser }, `review-rate-${viewport.width}`);
    const rateButton = browser.locator(".review-rate__button");
    await expect(rateButton).toContainText("30×", WAIT);

    await rateButton.tap();
    const menu = screen.getByRole("menu", { name: "再生の速さ" });
    await expect(menu).toBeVisible(WAIT);
    await expect(screen.getByRole("menuitem")).toHaveCount(4, WAIT);
    await screen.getByRole("menuitem", { name: /^60 倍/ }).tap();
    await expect(rateButton).toContainText("60×", WAIT);
    await expect(menu).toBeHidden(WAIT);

    const captions = screen.getByRole("button", { name: "字幕" });
    await expect(captions).toHaveAttribute("aria-pressed", before, WAIT);
    await captions.tap();
    await expect(captions).toHaveAttribute("aria-pressed", after, WAIT);
    const side = screen.getByRole("button", { name: "右の列" });
    await expect(side).toHaveAttribute("aria-pressed", before, WAIT);
    await side.tap();
    await expect(side).toHaveAttribute("aria-pressed", after, WAIT);
  }
});
