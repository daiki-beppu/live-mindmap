import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { cli, e2eDir, readRunInfo, type RunInfo, run } from "../runInfo.ts";

const script = JSON.parse(readFileSync(join(e2eDir, "fixtures/meeting.json"), "utf8")) as { events: { type: string; track: string; text: string }[] };
const APP = "us.zoom.xos";
const SMOKE_EVENTS = 4;
const WAIT = { timeout: 30_000 };

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

  const lastShown = lastCaption.type === "partial" ? browser.locator(".captions__bubble") : browser.locator(".map-node__text");
  await expect(lastShown.filter({ hasText: lastCaption.text })).toBeVisible(WAIT);

  if (runInfo.events === SMOKE_EVENTS) {
    const theirs = browser.locator(".captions__row").filter({ hasText: "検索の改善を先にやりた" });
    await expect(theirs).toHaveAttribute("class", /justify-start/);
    await expect(theirs.filter({ has: browser.locator(".captions__name").filter({ hasText: /^相手( B)?$/ }) })).toBeVisible();
    const mine = browser.locator(".captions__row").filter({ hasText: "担当を分け" });
    await expect(mine).toHaveAttribute("class", /justify-end/);
    await expect(browser.locator(".captions__name")).toHaveCount(2);
    await expect(browser.locator(".captions__name").filter({ hasText: /\S/ })).toHaveCount(1);
  }

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
