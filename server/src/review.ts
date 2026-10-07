// 見返し用の HTML（map.html）の書き出し。書き出しの時点で web を Vite の single-file ビルドにかけ、
// ログを差し込む（ビルド済みのテンプレートは持たない）。ビルドは MapCapture と同じ形の Service にして、テストで差し替える。
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer, Result, Schema } from "effect";
import { build } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { AudioMix } from "./audioMix.ts";
import { embedReviewAudio, embedReviewLicenses, embedReviewLog } from "./core/index.ts";

const WEB_ROOT = join(import.meta.dirname, "../../web");

// 見返し用の HTML の書き出しの失敗。呼び出し側（CLI・server）は message をそのまま「map.html を書き出せませんでした: …」の理由に使う
export class ReviewPageFailed extends Schema.TaggedError<ReviewPageFailed>()("ReviewPageFailed", { message: Schema.String }) {}

const failed = (e: unknown) => new ReviewPageFailed({ message: e instanceof Error ? e.message : String(e) });

// 書き出す版。audio が true なら、録音を mix して埋め込む。track が `自分` なら、その声だけを混ぜる（省略すると全トラック）
export type ReviewVariant = { readonly file: string; readonly audio: boolean; readonly track?: "自分" };

// 書き出さなかった版と、その理由
export type SkippedReviewVariant = { readonly file: string; readonly reason: string };

// 書き出した結果。paths は書けた版のパス（版の順）、skipped は諦めた版（呼び出し側が理由を標準エラーに出す）
export type ReviewPagesResult = { readonly paths: string[]; readonly skipped: SkippedReviewVariant[] };

// 書き出しの口を Promise で受け取る側（まだ Effect にしていない server.ts の終了処理）のための形。
// server.ts の入口が writeReviewPages に Layer を渡して、この形を 1 つ組んで渡す
export type PromiseReviewPages = (dir: string, logPath: string, variants: readonly ReviewVariant[]) => Promise<ReviewPagesResult>;

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

// mix の出力を一時フォルダに書き、base64 にして返す。mix は既にある出力を上書きしないので、出力先は新しい一時フォルダで、acquireRelease が必ず消す。
// 失敗は mix の理由（AudioMixFailed の message）を文字列で返す（版を諦めるだけで、全体の失敗にはしない）
const mixedAudio = Effect.fnUntraced(function* (dir: string, track?: "自分") {
  const { mix } = yield* AudioMix;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.tryPromise({ try: () => mkdtemp(join(tmpdir(), "live-mindmap-audio-")), catch: (e) => e instanceof Error ? e.message : String(e) }),
        (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
      );
      const out = join(tmp, "mix.m4a");
      yield* mix(dir, out, track).pipe(Effect.mapError((e) => e.message));
      const bytes = yield* Effect.tryPromise({ try: () => readFile(out), catch: (e) => e instanceof Error ? e.message : String(e) });
      return bytes.toString("base64");
    }),
  );
});

// log.jsonl の出来事を、版ごとに 1 つの HTML へ埋め込んで dir に書き、書いたパスを版の順に返す。ビルドは 1 回だけ。
// ログが読めない・ビルドに失敗したら、何も書かずに ReviewPageFailed で終わる。
// 音声つきの版で mix が失敗したら、その版だけを諦めて skipped に理由を返す（ほかの版は書く）。音声は版のファイルを書く前に取る
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
  const pages: { path: string; html: string }[] = [];
  const skipped: SkippedReviewVariant[] = [];
  for (const variant of variants) {
    const html = yield* Effect.try({ try: () => embedReviewLog(template, events), catch: failed });
    if (!variant.audio) {
      pages.push({ path: join(dir, variant.file), html });
      continue;
    }
    const audio = yield* Effect.result(mixedAudio(dir, variant.track));
    if (Result.isFailure(audio)) {
      skipped.push({ file: variant.file, reason: audio.failure });
      continue;
    }
    const withAudio = yield* Effect.try({ try: () => embedReviewAudio(html, audio.success), catch: failed });
    pages.push({ path: join(dir, variant.file), html: withAudio });
  }
  for (const page of pages) yield* Effect.tryPromise({ try: () => writeFile(page.path, page.html), catch: failed });
  return { paths: pages.map((page) => page.path), skipped } satisfies ReviewPagesResult;
});
