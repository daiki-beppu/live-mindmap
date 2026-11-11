import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { Playwright } from "../src/playwright.ts";
import { managedPlaywright } from "./fixtures/managedPlaywright.ts";
import { REVIEW_LICENSES_ELEMENT_ID, REVIEW_LOG_ELEMENT_ID } from "../src/core/index.ts";
import { ReviewBuild, writeReviewPages } from "../src/review.ts";
import { embeddedAudio, fakeAudioMix, FAKE_MIX_BYTES } from "./fixtures/audioMix.ts";

const TIMEOUT = 90_000;

const WEB_DIST = join(import.meta.dirname, "../../web/dist");

const BUNDLED_LICENSES = ["foldkit", "effect"].map((name) => ({
  name,
  text: readFileSync(join(import.meta.dirname, "../../web/node_modules", name, "LICENSE"), "utf8").trim(),
}));

const ICONS_NOTICE = readFileSync(join(import.meta.dirname, "../../web/src/app/review/icons.NOTICE.md"), "utf8").trim();

const events = [
  { at: "2026-10-07T00:00:00.000Z", type: "start", title: "定例</script>" },
  { at: "2026-10-07T00:00:01.000Z", type: "remark", remark: { id: "r1", track: "相手", start: 0, end: 5, text: "採用の話をします" } },
  {
    at: "2026-10-07T00:00:02.000Z",
    type: "diff",
    input: { recent: [], fresh: ["r1"], nodeCount: 0 },
    ops: [
      { op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: ["r1"] },
      { op: "add", ref: "t2", parent: "root", kind: "要点", text: "採用方法", evidence: ["r1"] },
    ],
    dropped: [],
  },
  { type: "supplement", op: { op: "add", parent: "n1", text: "会議の外から添える説明", evidence: ["r1"], origin: "会議の外" }, category: null, ms: 1, reflectedAt: 6 },
  { type: "supplement", op: { op: "add", parent: "n2", text: "会議の中から添える説明", evidence: ["r1"], origin: "会議の中" }, category: null, ms: 1, reflectedAt: 7 },
];

describe("map.html の本物のビルド", () => {
  it.live(
    "single-file の HTML ができ、埋め込んだログを読み戻せる。file:// で開くと最後のマップが出て、取り込みの知らせは出ない。リポジトリに生成物を残さない",
    () => Effect.gen(function* () {
      const distBefore = existsSync(WEB_DIST) ? yield* Effect.tryPromise(() => readdir(WEB_DIST)) : null;
      const dir = yield* Effect.acquireRelease(
        Effect.tryPromise(() => mkdtemp(join(tmpdir(), "live-mindmap-review-real-"))),
        (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
      );

      const { paths: [path, audioPath], skipped } = yield* writeReviewPages(dir, events, [{ file: "map.html", audio: false }, { file: "map-audio.html", audio: true }]).pipe(
        Effect.provide(Layer.mergeAll(ReviewBuild.layer, fakeAudioMix().layer).pipe(Layer.provideMerge(NodeFileSystem.layer))),
      );

      expect(skipped).toEqual([]);
      expect(path).toBe(join(dir, "map.html"));
      expect(audioPath).toBe(join(dir, "map-audio.html"));
      const audioHtml = yield* Effect.tryPromise(() => readFile(audioPath!, "utf8"));
      expect(embeddedAudio(audioHtml)).toEqual(FAKE_MIX_BYTES);
      const audioLog = new RegExp(`<script type="application/json" id="${REVIEW_LOG_ELEMENT_ID}">([\\s\\S]*?)</script>`).exec(audioHtml);
      expect(JSON.parse(audioLog![1]!)).toMatchObject(events);
      expect(JSON.parse(audioLog![1]!).filter((row: { type: string }) => row.type !== "supplement")).toEqual(events.filter((row) => row.type !== "supplement"));
      expect(embeddedAudio(yield* Effect.tryPromise(() => readFile(path!, "utf8")))).toBeNull();
      const html = yield* Effect.tryPromise(() => readFile(path!, "utf8"));
      const markup = html.replace(/(<(script|style)\b[^>]*>)[\s\S]*?<\/\2>/g, "$1</$2>");
      expect(markup).not.toMatch(/<script[^>]*\ssrc=/);
      expect(markup).not.toMatch(/<link[^>]*rel="stylesheet"/);
      const match = new RegExp(`<script type="application/json" id="${REVIEW_LOG_ELEMENT_ID}">([\\s\\S]*?)</script>`).exec(html);
      expect(JSON.parse(match![1]!)).toMatchObject(events);
      expect(JSON.parse(match![1]!).filter((row: { type: string }) => row.type !== "supplement")).toEqual(events.filter((row) => row.type !== "supplement"));

      const css = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]!).join("\n");
      expect(css.length).toBeGreaterThan(0);
      expect(css).toMatch(/@keyframes map-node-blink/);
      expect(css).toMatch(/\.map-node--blink\s*\{[^}]*animation\s*:[^;}]*\b1s\b[^;}]*\s3\b/);
      expect(css).toMatch(/--color-yellow-400\s*:\s*#facc15/i);

      for (const { name } of BUNDLED_LICENSES) expect(html).toContain(`## ${name} - `);
      for (const gone of ["react", "react-dom", "@xyflow/react", "@videojs/react", "@tanstack/react-hotkeys"]) expect(html, gone).not.toContain(`## ${gone} - `);

      const seen = yield* Effect.acquireUseRelease(
        (yield* Playwright).launch,
        (browser) => Effect.tryPromise(async () => {
          const context = await browser.newContext();
          try {
            const page = await context.newPage();
            await page.goto(pathToFileURL(path!).href);
            await page.locator(".map-node").first().waitFor({ timeout: 30_000 });
            const supplementStyles = [];
            for (const text of ["会議の外から添える説明", "会議の中から添える説明"]) {
              const button = page.getByRole("button", { name: text, exact: true });
              await button.waitFor({ state: "visible", timeout: 10_000 });
              supplementStyles.push(await button.evaluate((element) => {
                const style = getComputedStyle(element);
                const node = element.closest(".map-node")!;
                return { text: element.textContent, fontStyle: style.fontStyle, color: style.color, shadow: getComputedStyle(node).boxShadow, marks: node.querySelectorAll(".map-node__mark").length };
              }));
            }
            const licenses = await page.evaluate(
              (id) => (document.getElementById(id) as HTMLTemplateElement | null)?.content.textContent ?? null,
              REVIEW_LICENSES_ELEMENT_ID,
            );
            const bodyText = await page.evaluate(() => document.body.innerText);
            return {
              supplementStyles,
              licenses,
              bodyText,
              nodes: await page.locator(".map-node").allInnerTexts(),
              intake: await page.locator(".intake-notice").count(),
              changes: await page.locator(".changes__item").allInnerTexts(),
              evidenceBefore: await page.locator(".evidence__remark").count(),
              evidence: await (async () => {
                await page.locator(".changes__button").first().click();
                await page.locator(".evidence__remark").first().waitFor({ timeout: 10_000 });
                return page.locator(".evidence__remark").allInnerTexts();
              })(),
            };
          } finally {
            await context.close();
          }
        }),
        (browser) => Effect.promise(() => browser.close()),
      );
      for (const { name, text } of BUNDLED_LICENSES) {
        expect(seen.licenses, name).toContain(text);
        expect(seen.bodyText, name).not.toContain(text.split("\n")[0]!.trim());
      }
      expect(seen.licenses, "icons.NOTICE.md").toContain(ICONS_NOTICE);
      expect(seen.bodyText, "icons.NOTICE.md").not.toContain(ICONS_NOTICE.split("\n")[0]!.trim());
      expect(seen.nodes.join("\n")).toContain("採用");
      expect(seen.intake).toBe(0);
      expect(seen.changes).toHaveLength(2);
      expect(seen.changes[0]).toContain("採用");
      expect(seen.evidenceBefore).toBe(0);
      expect(seen.evidence.join("\n")).toContain("採用の話をします");
      expect(seen.supplementStyles).toEqual([
        { text: "会議の外から添える説明", fontStyle: "italic", color: "rgb(123, 168, 161)", shadow: "none", marks: 0 },
        { text: "会議の中から添える説明", fontStyle: "normal", color: "rgb(15, 118, 110)", shadow: "none", marks: 0 },
      ]);

      const distAfter = existsSync(WEB_DIST) ? yield* Effect.tryPromise(() => readdir(WEB_DIST)) : null;
      expect(distAfter).toEqual(distBefore);
    }).pipe(Effect.provide(managedPlaywright), Effect.scoped),
    TIMEOUT,
  );
});
