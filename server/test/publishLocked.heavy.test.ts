import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { generatePassphrase, lockedPublishPage, PUBLISH_TITLE, replaceHeadForPublish, sealWithPassphrase } from "../src/core/index.ts";
import { Playwright } from "../src/playwright.ts";
import { ReviewBuild, writeReviewPages } from "../src/review.ts";
import { fakeAudioMix } from "./fixtures/audioMix.ts";
import { managedPlaywright } from "./fixtures/managedPlaywright.ts";

// 合言葉で暗号化した外側のページを、実物の見返しのビルドと Chromium で開く（Issue #1251）。時間がかかる。
// 事前に `pnpm cli install chromium` が要る。
const TIMEOUT = 120_000;

const events = [
  { at: "2026-10-07T00:00:00.000Z", type: "start", title: "定例" },
  { at: "2026-10-07T00:00:01.000Z", type: "remark", remark: { id: "r1", track: "相手", start: 0, end: 5, text: "採用の話をします" } },
  {
    at: "2026-10-07T00:00:02.000Z",
    type: "diff",
    input: { recent: [], fresh: ["r1"], nodeCount: 0 },
    ops: [{ op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: ["r1"] }],
    dropped: [],
  },
];

describe("合言葉で暗号化した外側のページ", () => {
  it.live(
    "合言葉の入力欄だけが見え、違う合言葉では「合言葉が違います」が出てマップは出ない。正しい合言葉（前後の空白つき）でマップが開く",
    () => Effect.gen(function* () {
      const dir = yield* Effect.acquireRelease(
        Effect.tryPromise(() => mkdtemp(join(tmpdir(), "live-mindmap-locked-"))),
        (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
      );
      const logPath = join(dir, "log.jsonl");
      writeFileSync(logPath, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
      const { paths: [mapPath] } = yield* writeReviewPages(dir, logPath, [{ file: "index.html", audio: false, mapOnly: true }]).pipe(
        Effect.provide(Layer.mergeAll(ReviewBuild.layer, fakeAudioMix().layer).pipe(Layer.provideMerge(NodeFileSystem.layer))),
      );
      const inner = replaceHeadForPublish(yield* Effect.tryPromise(() => readFile(mapPath!, "utf8")));
      const passphrase = generatePassphrase();
      const outerPath = join(dir, "locked.html");
      writeFileSync(outerPath, lockedPublishPage(yield* Effect.tryPromise(() => sealWithPassphrase(inner, passphrase))));

      const seen = yield* Effect.acquireUseRelease(
        (yield* Playwright).launch(),
        (browser) => Effect.tryPromise(async () => {
          const page = await browser.newPage();
          await page.goto(pathToFileURL(outerPath).href);
          const input = page.locator("input");
          await input.first().waitFor({ timeout: 30_000 });
          const before = { title: await page.title(), inputs: await input.count(), nodes: await page.locator(".map-node").count() };

          await input.first().fill(`${passphrase}x`);
          await input.first().press("Enter");
          await page.getByRole("alert").filter({ hasText: "合言葉が違います" }).waitFor({ timeout: 60_000 });
          const afterWrong = { nodes: await page.locator(".map-node").count(), body: await page.evaluate(() => document.body.innerText) };

          await input.first().fill(`  ${passphrase}\n`);
          await input.first().press("Enter");
          await page.locator(".map-node").first().waitFor({ timeout: 60_000 });
          return {
            before,
            afterWrong,
            nodes: await page.locator(".map-node").allInnerTexts(),
            title: await page.title(),
          };
        }),
        (browser) => Effect.promise(() => browser.close()),
      );

      expect(seen.before).toEqual({ title: PUBLISH_TITLE, inputs: 1, nodes: 0 });
      expect(seen.afterWrong.nodes).toBe(0);
      expect(seen.afterWrong.body).toContain("合言葉が違います");
      expect(seen.nodes.join("\n")).toContain("採用");
      // 開いた後の title はマップのアプリが書く（live-mindmap）。会議名は出ない
      expect(seen.title).not.toContain("定例");
    }).pipe(Effect.provide(managedPlaywright), Effect.scoped),
    TIMEOUT,
  );
});
