import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { launchBrowser } from "../../test/browser.ts";
import { openReviewPage, prepareReviewPages, settled } from "../../test/reviewBrowser.ts";
import { meetingFrames, NOTICE_FRAMES, openMeetingPage, sendFrame, startMeetingServer } from "../../test/meetingPage.ts";
import { spokenFrame } from "../../test/fixtures/captions.ts";

const VIEWPORTS = [{ width: 1280, height: 800 }, { width: 390, height: 844 }];
const WAIT_MS = 10_000;

export async function readStablePage(page, timeout = WAIT_MS) {
  await page.evaluate(async (timeoutMs) => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("document.fonts.ready timeout")), timeoutMs);
      document.fonts.ready.then(() => { clearTimeout(timer); resolve(); }, (error) => { clearTimeout(timer); reject(error); });
    });
  }, timeout);
  if (await page.locator(".map-viewport").count()) await settled(page);
  await page.mouse.move(0, 0);
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  try {
    await page.waitForFunction(() => document.getAnimations().length === 0, undefined, { timeout });
  } catch (cause) {
    throw new Error("document.getAnimations().length === 0 timeout", { cause });
  }
  return page.evaluate(() => {
    if (document.getAnimations().length !== 0) throw new Error("document.getAnimations().length === 0 changed before capture");
    const pathOf = (element) => {
      const parts = [];
      for (let node = element; node; node = node.parentElement) {
        parts.unshift(node.localName + ":" + (node.parentElement ? [...node.parentElement.children].indexOf(node) : 0));
      }
      return parts.join("/");
    };
    return [...document.querySelectorAll("*")].map((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return {
        path: pathOf(element), tag: element.localName,
        // CSS/JSソースの文字列は表示内容ではなく、ビルドごとに変わる。
        text: ["style", "script"].includes(element.localName) ? "" : [...element.childNodes].filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent).join(""),
        style: Object.fromEntries([...style].sort().map((key) => [key, style.getPropertyValue(key)])),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left },
      };
    });
  });
}

const todoSnapshot = {
  nodes: [
    { id: "root", parent: null, kind: "会議", text: "照合用会議", evidence: [] },
    { id: "topic", parent: "root", kind: "議題", text: "採用", evidence: ["r1"] },
    { id: "point", parent: "topic", kind: "論点", text: "面接は何回か", evidence: ["r1"], pointStatus: "未決" },
    { id: "todo", parent: "topic", kind: "TODO", text: "求人を出す長い本文の折り返しも確認します", evidence: ["r1"], assignee: "佐藤", due: "来週" },
  ],
  remarks: [{ id: "r1", track: "相手", start: 65, end: 71, text: "二回でいきます。根拠の発言も確認します。" }],
  changes: [{ round: 1, at: 65, change: "追加", node: "todo", kind: "TODO", text: "求人を出す長い本文の折り返しも確認します" }],
  round: 1, currentTopic: "topic", now: 72,
};

async function selectNode(page, id) {
  await settled(page);
  const index = await page.evaluate(() => [...document.querySelectorAll(".map-node__button")].findIndex((el) => {
    const r = el.getBoundingClientRect();
    return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
  }));
  if (index < 0) throw new Error("画面の中に選択可能なノードがありません");
  const node = id ? page.locator('[data-node-id="' + id + '"] button.map-node__button') : page.locator("button.map-node__button").nth(index);
  await node.click();
  await page.locator(".evidence__text").first().waitFor({ state: "attached", timeout: WAIT_MS });
}

async function reviewScene(context, pages, scene) {
  const page = await openReviewPage(context, pages.plainPath, { audio: false });
  if (scene === "rate") {
    await page.getByRole("button", { name: "再生の速さ", exact: true }).click();
    await page.locator(".review-rate__menu").waitFor({ timeout: WAIT_MS });
  } else if (scene === "keys") {
    await page.keyboard.press("?");
    await page.locator(".key-list").waitFor({ timeout: WAIT_MS });
  } else if (scene === "folded" || scene === "opened") {
    const count = page.getByRole("button", { name: "開く", exact: true }).first();
    await count.waitFor({ timeout: WAIT_MS });
    if (scene === "opened") {
      await count.click();
      await page.getByRole("button", { name: "畳む", exact: true }).first().waitFor({ timeout: WAIT_MS });
    }
  } else if (scene === "side") {
    await selectNode(page);
    const toggle = page.getByRole("button", { name: "右の列", exact: true });
    if (await toggle.getAttribute("aria-pressed") === "false") await toggle.click();
    await page.locator(".side").waitFor({ state: "visible", timeout: WAIT_MS });
  }
  return page;
}

async function meetingScene(context, server, frames, scene) {
  const page = await openMeetingPage(context, server, { frames: scene === "todo" ? [{ type: "snapshot", snapshot: todoSnapshot }] : frames.first });
  if (scene === "captions" || scene === "notices") {
    if (!await page.locator(".captions").count()) await page.keyboard.press("c");
    await sendFrame(page, spokenFrame("確定済みの字幕で表示と寸法を照合します"));
    await page.locator(".captions__bubble").first().waitFor({ timeout: WAIT_MS });
  }
  if (scene === "notices") {
    await sendFrame(page, { type: "intake", status: "interrupted" });
    await sendFrame(page, NOTICE_FRAMES.screen);
    await sendFrame(page, NOTICE_FRAMES.tap);
    for (const selector of [".intake-notice", ".screen-notice", ".tap-notice"]) await page.locator(selector).first().waitFor({ timeout: WAIT_MS });
  }
  if (scene === "side" || scene === "todo") await selectNode(page, scene === "todo" ? "point" : undefined);
  return page;
}

async function capture(root, revision, output) {
  const { buildReviewTemplateHtml } = await import(pathToFileURL(join(root, "server/test/fixtures/reviewTemplate.ts")).href);
  const pages = await prepareReviewPages(await buildReviewTemplateHtml());
  try {
    const server = await startMeetingServer(join(root, "web"));
    try {
      const browser = await launchBrowser();
      try {
        const frames = await meetingFrames();
        const scenes = [];
        for (const viewport of VIEWPORTS) {
          for (const [mode, names] of [["review", ["initial", "rate", "keys", "folded", "opened", "side"]], ["meeting", ["captions", "notices", "side", "todo"]]]) {
            for (const name of names) {
              const context = await browser.newContext({ viewport, locale: "ja-JP", timezoneId: "Asia/Tokyo", colorScheme: "light" });
              try {
                const page = mode === "review" ? await reviewScene(context, pages, name) : await meetingScene(context, server, frames, name);
                const elements = await readStablePage(page);
                const sceneName = mode + "/" + name + "/" + viewport.width;
                scenes.push({ name: sceneName, viewport, elements });
                process.stdout.write(sceneName + ": " + elements.length + " elements\n");
              } finally {
                await context.close();
              }
            }
          }
        }
        const sources = {};
        for (const file of ["web/src/app/sidePanel/main.ts", "web/src/styles.css"]) sources[file] = createHash("sha256").update(await readFile(join(root, file))).digest("hex");
        await writeFile(output, JSON.stringify({
          version: 1, revision, sources,
          environment: { browser: browser.version(), platform: process.platform, arch: process.arch, node: process.version, locale: "ja-JP", timezoneId: "Asia/Tokyo", colorScheme: "light" },
          scenes,
        }, null, 2) + "\n");
      } finally {
        await browser.close();
      }
    } finally {
      await server.close();
    }
  } finally {
    await pages.dispose();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [root, revision, output] = process.argv.slice(2);
    if (!root || !revision || !output) throw new Error("node capture.mjs REPO_ROOT REVISION OUTPUT.json");
    await capture(resolve(root), revision, resolve(output));
  } catch (error) {
    process.stderr.write(String(error) + "\n");
    process.exitCode = 1;
  }
}
