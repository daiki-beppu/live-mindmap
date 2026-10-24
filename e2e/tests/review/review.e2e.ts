import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test, type Browser } from "@e2e-dev/web";
import { expect } from "e2e";
import { cli, e2eDir, readRunInfo, run } from "../runInfo.ts";

const WAIT = { timeout: 30_000 };
const ALL_NODES = 4;
const ROOT_ONLY = 1;

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

test("見返し: 速さのメニューから速さを選べ、閉じた後は字幕・右の列のボタンが効く。スマホの幅では字幕と右の列を隠して始める", async ({ app, browser, screen }) => {
  for (const { viewport, startsHidden } of [{ viewport: { width: 1280, height: 720 }, startsHidden: false }, { viewport: { width: 390, height: 844 }, startsHidden: true }]) {
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
