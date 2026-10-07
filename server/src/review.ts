// 見返し用の HTML（map.html）の書き出し。書き出しの時点で web を Vite の single-file ビルドにかけ、
// ログを差し込む（ビルド済みのテンプレートは持たない）。ビルドは MapCapture と同じ形の Service にして、テストで差し替える。
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer, Schema } from "effect";
import { build } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { embedReviewLicenses, embedReviewLog } from "./core/index.ts";

const WEB_ROOT = join(import.meta.dirname, "../../web");

// 見返し用の HTML の書き出しの失敗。呼び出し側（CLI・server）は message をそのまま「map.html を書き出せませんでした: …」の理由に使う
export class ReviewPageFailed extends Schema.TaggedError<ReviewPageFailed>()("ReviewPageFailed", { message: Schema.String }) {}

const failed = (e: unknown) => new ReviewPageFailed({ message: e instanceof Error ? e.message : String(e) });

// 書き出す版。今は map.html だけ（後で音声つきと `自分` だけの版を足す）
export type ReviewVariant = { readonly file: string };

// 書き出しの口を Promise で受け取る側（まだ Effect にしていない server.ts の終了処理）のための形。
// server.ts の入口が writeReviewPages に Layer を渡して、この形を 1 つ組んで渡す
export type PromiseReviewPages = (dir: string, logPath: string, variants: readonly ReviewVariant[]) => Promise<string[]>;

// web を single-file の HTML 1 つにビルドして、その文字列を返す。出力は一時フォルダに書き、acquireRelease が必ず消す。
// Why: Vite の build は中断できず、中断されたファイバーは完了を待たない。中断可能のままだと、ビルドが使っている outDir を先に消してしまうため、
// 一時フォルダを使う処理（ビルドと読み取り）が終わるまで中断を遅らせる
const buildReviewTemplate = Effect.fnUntraced(function* () {
  const out = yield* Effect.acquireRelease(
    Effect.tryPromise({ try: () => mkdtemp(join(tmpdir(), "live-mindmap-review-")), catch: failed }),
    (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
  );
  yield* Effect.tryPromise({
    try: () =>
      build({
        root: WEB_ROOT,
        configFile: join(WEB_ROOT, "vite.config.ts"),
        logLevel: "silent",
        // Why: インライン化した chunk を bundle から消すと、build.license が同梱モジュールを集められない。出力は一時フォルダで、index.html だけ読む
        plugins: [viteSingleFile({ deleteInlinedFiles: false })],
        build: { outDir: out, emptyOutDir: true, license: true },
      }),
    catch: failed,
  });
  const html = yield* Effect.tryPromise({ try: () => readFile(join(out, "index.html"), "utf8"), catch: failed });
  const licenses = yield* Effect.tryPromise({ try: () => readFile(join(out, ".vite/license.md"), "utf8"), catch: failed });
  return yield* Effect.try({ try: () => embedReviewLicenses(html, licenses), catch: failed });
}, Effect.scoped, Effect.uninterruptible);

// 見返し用の HTML のテンプレート（ログを差し込む前）をビルドする
export class ReviewBuild extends Context.Service<ReviewBuild, {
  readonly build: () => Effect.Effect<string, ReviewPageFailed>;
}>()("live-mindmap/server/ReviewBuild") {
  static readonly layer = Layer.succeed(ReviewBuild, ReviewBuild.of({ build: buildReviewTemplate }));
}

// log.jsonl の出来事を、版ごとに 1 つの HTML へ埋め込んで dir に書き、書いたパスを版の順に返す。ビルドは 1 回だけ。
// どこかで失敗したら、何も書かずに ReviewPageFailed で終わる
export const writeReviewPages = Effect.fnUntraced(function* (dir: string, logPath: string, variants: readonly ReviewVariant[]) {
  const text = yield* Effect.tryPromise({ try: () => readFile(logPath, "utf8"), catch: failed });
  const events: unknown[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (line.trim() === "") continue;
    events.push(
      yield* Effect.try({
        try: (): unknown => JSON.parse(line),
        catch: (e) => new ReviewPageFailed({ message: `${logPath} の ${index + 1} 行目が JSON として読めません: ${e instanceof Error ? e.message : String(e)}` }),
      }),
    );
  }
  const { build } = yield* ReviewBuild;
  const template = yield* build();
  const pages = yield* Effect.try({
    try: () => variants.map((variant) => ({ path: join(dir, variant.file), html: embedReviewLog(template, events) })),
    catch: failed,
  });
  for (const page of pages) yield* Effect.tryPromise({ try: () => writeFile(page.path, page.html), catch: failed });
  return pages.map((page) => page.path);
});
