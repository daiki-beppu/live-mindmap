import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

// 実物の Vite（single-file）と Chromium で、書き出した map.html を file:// で開く。時間がかかる。
// 事前に `pnpm cli install chromium` が要る。
const TIMEOUT = 90_000;

const WEB_DIST = join(import.meta.dirname, "../../web/dist");

// pnpm が web の依存として置いた LICENSE（web/node_modules の symlink 先）。パッケージ名は、ビルドが同梱したことの確認にだけ使う
const BUNDLED_LICENSES = ["react", "@xyflow/react"].map((name) => ({
  name,
  text: readFileSync(join(import.meta.dirname, "../../web/node_modules", name, "LICENSE"), "utf8").trim(),
}));

const events = [
  { at: "2026-10-07T00:00:00.000Z", type: "start", title: "定例</script>" },
  { at: "2026-10-07T00:00:01.000Z", type: "remark", remark: { id: "r1", track: "相手", start: 0, end: 5, text: "採用の話をします" } },
  {
    at: "2026-10-07T00:00:02.000Z",
    type: "diff",
    input: { recent: [], fresh: ["r1"], nodeCount: 0 },
    ops: [{ op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: ["r1"] }],
    dropped: [],
  },
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
      const logPath = join(dir, "log.jsonl");
      writeFileSync(logPath, events.map((e) => JSON.stringify(e)).join("\n") + "\n");

      // 本物のビルドは 1 回だけ。音声つきの版には、偽の mix の出力（小さなバイト列）を埋め込む
      const { paths: [path, audioPath], skipped } = yield* writeReviewPages(dir, logPath, [{ file: "map.html", audio: false }, { file: "map-audio.html", audio: true }]).pipe(
        Effect.provide(Layer.mergeAll(ReviewBuild.layer, fakeAudioMix().layer).pipe(Layer.provideMerge(NodeFileSystem.layer))),
      );

      expect(skipped).toEqual([]);
      expect(path).toBe(join(dir, "map.html"));
      expect(audioPath).toBe(join(dir, "map-audio.html"));
      // 本物のビルドのテンプレートに埋め込んだ音声を、元のバイト列に読み戻せる。ログも同じ HTML から読み戻せ、map.html には音声が入らない
      const audioHtml = yield* Effect.tryPromise(() => readFile(audioPath!, "utf8"));
      expect(embeddedAudio(audioHtml)).toEqual(FAKE_MIX_BYTES);
      const audioLog = new RegExp(`<script type="application/json" id="${REVIEW_LOG_ELEMENT_ID}">([\\s\\S]*?)</script>`).exec(audioHtml);
      expect(JSON.parse(audioLog![1]!)).toEqual(events);
      expect(embeddedAudio(yield* Effect.tryPromise(() => readFile(path!, "utf8")))).toBeNull();
      const html = yield* Effect.tryPromise(() => readFile(path!, "utf8"));
      // インライン化した JS・CSS の中身にタグに見える文字列があっても、外部参照とは数えない
      const markup = html.replace(/(<(script|style)\b[^>]*>)[\s\S]*?<\/\2>/g, "$1</$2>");
      expect(markup).not.toMatch(/<script[^>]*\ssrc=/);
      expect(markup).not.toMatch(/<link[^>]*rel="stylesheet"/);
      const match = new RegExp(`<script type="application/json" id="${REVIEW_LOG_ELEMENT_ID}">([\\s\\S]*?)</script>`).exec(html);
      expect(JSON.parse(match![1]!)).toEqual(events);

      // 同梱したライブラリの名前と LICENSE の全文が、HTML の中の表示されない要素に残る
      for (const { name } of BUNDLED_LICENSES) expect(html).toContain(`## ${name} - `);

      const seen = yield* Effect.acquireUseRelease(
        (yield* Playwright).launch(),
        (browser) => Effect.tryPromise(async () => {
          const page = await browser.newPage();
          await page.goto(pathToFileURL(path!).href);
          await page.locator(".map-node").first().waitFor({ timeout: 30_000 });
          const licenses = await page.evaluate(
            (id) => (document.getElementById(id) as HTMLTemplateElement | null)?.content.textContent ?? null,
            REVIEW_LICENSES_ELEMENT_ID,
          );
          const bodyText = await page.evaluate(() => document.body.innerText);
          return {
            licenses,
            bodyText,
            nodes: await page.locator(".map-node").allInnerTexts(),
            intake: await page.locator(".intake-notice").count(),
            changes: await page.locator(".changes__item").allInnerTexts(),
            // 「変わったこと」の項目を選ぶと、根拠の発言が右の列に出る
            evidenceBefore: await page.locator(".evidence__remark").count(),
            evidence: await (async () => {
              await page.locator(".changes__button").first().click();
              await page.locator(".evidence__remark").first().waitFor({ timeout: 10_000 });
              return page.locator(".evidence__remark").allInnerTexts();
            })(),
          };
        }),
        (browser) => Effect.promise(() => browser.close()),
      );
      for (const { name, text } of BUNDLED_LICENSES) {
        expect(seen.licenses, name).toContain(text);
        // 画面に出ていない（上で HTML の中にあると確かめた文言の、先頭の行が本文に無い）
        expect(seen.bodyText, name).not.toContain(text.split("\n")[0]!.trim());
      }
      expect(seen.nodes.join("\n")).toContain("採用");
      expect(seen.intake).toBe(0);
      expect(seen.changes).toHaveLength(1);
      expect(seen.changes[0]).toContain("採用");
      expect(seen.evidenceBefore).toBe(0);
      expect(seen.evidence.join("\n")).toContain("採用の話をします");

      const distAfter = existsSync(WEB_DIST) ? yield* Effect.tryPromise(() => readdir(WEB_DIST)) : null;
      expect(distAfter).toEqual(distBefore);
    }).pipe(Effect.provide(managedPlaywright), Effect.scoped),
    TIMEOUT,
  );
});
