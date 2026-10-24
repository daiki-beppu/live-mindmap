import { join } from "node:path";
import { Context, Effect, FileSystem, Layer, Result, Schema } from "effect";
import { build } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { AudioMix } from "./audioMix.ts";
import { embedReviewAudio, embedReviewLicenses, embedReviewLog, mapOnlyReviewEvents } from "./core/index.ts";

const WEB_ROOT = join(import.meta.dirname, "../../web");
// 見返しの操作の行が写した video.js のアイコンの出どころとライセンス（Apache-2.0）。Vite の build.license はパッケージ単位で、写したファイルは載らないので、ここで足す
const ICONS_NOTICE_PATH = join(WEB_ROOT, "src/app/review/icons.NOTICE.md");

export class ReviewPageFailed extends Schema.TaggedError<ReviewPageFailed>()("ReviewPageFailed", { message: Schema.String }) {}

const failed = (e: unknown) => new ReviewPageFailed({ message: e instanceof Error ? e.message : String(e) });

export type ReviewVariant =
  | { readonly file: string; readonly audio: false; readonly mapOnly?: true }
  | { readonly file: string; readonly audio: true; readonly track?: "自分" };

export type SkippedReviewVariant = { readonly file: string; readonly reason: string };

export type ReviewPagesResult = { readonly paths: string[]; readonly skipped: SkippedReviewVariant[] };

// Why: Vite の build は中断できず、中断されたファイバーは完了を待たない。中断可能のままだと、ビルドが使っている outDir を先に消してしまうため、
// 一時フォルダを使う処理（ビルドと読み取り）が終わるまで中断を遅らせる
const buildReviewTemplate = Effect.fnUntraced(function* (fs: FileSystem.FileSystem) {
  const out = yield* fs.makeTempDirectoryScoped({ prefix: "live-mindmap-review-" }).pipe(Effect.mapError(failed));
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
  const html = yield* fs.readFileString(join(out, "index.html")).pipe(Effect.mapError(failed));
  const bundledLicenses = yield* fs.readFileString(join(out, ".vite/license.md")).pipe(Effect.mapError(failed));
  const iconsNotice = yield* fs.readFileString(ICONS_NOTICE_PATH).pipe(Effect.mapError(failed));
  return yield* Effect.try({ try: () => embedReviewLicenses(html, `${bundledLicenses.trimEnd()}\n\n${iconsNotice.trim()}\n`), catch: failed });
}, Effect.scoped, Effect.uninterruptible);

export class ReviewBuild extends Context.Service<ReviewBuild, {
  readonly build: Effect.Effect<string, ReviewPageFailed>;
}>()("live-mindmap/server/ReviewBuild") {
  static readonly layer: Layer.Layer<ReviewBuild, never, FileSystem.FileSystem> = Layer.effect(ReviewBuild)(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return ReviewBuild.of({ build: buildReviewTemplate(fs) });
    }),
  );
}

const mixedAudio = Effect.fnUntraced(function* (dir: string, track?: "自分") {
  const { mix } = yield* AudioMix;
  const fs = yield* FileSystem.FileSystem;
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "live-mindmap-audio-" });
      const out = join(tmp, "mix.m4a");
      yield* mix(dir, out, track);
      const bytes = yield* fs.readFile(out);
      return Buffer.from(bytes).toString("base64");
    }),
  ).pipe(Effect.mapError((e) => e.message));
});

export const renderReviewPages = Effect.fnUntraced(function* (sessionDir: string, events: readonly unknown[], variants: readonly ReviewVariant[]) {
  const { build } = yield* ReviewBuild;
  const template = yield* build;
  const pages: { file: string; html: string }[] = [];
  const skipped: SkippedReviewVariant[] = [];
  for (const variant of variants) {
    if (!variant.audio) {
      const html = yield* Effect.try({ try: () => embedReviewLog(template, variant.mapOnly ? mapOnlyReviewEvents(events) : events), catch: failed });
      pages.push({ file: variant.file, html });
      continue;
    }
    const html = yield* Effect.try({ try: () => embedReviewLog(template, events), catch: failed });
    const audio = yield* Effect.result(mixedAudio(sessionDir, variant.track));
    if (Result.isFailure(audio)) {
      skipped.push({ file: variant.file, reason: audio.failure });
      continue;
    }
    const withAudio = yield* Effect.try({ try: () => embedReviewAudio(html, audio.success), catch: failed });
    pages.push({ file: variant.file, html: withAudio });
  }
  return { pages, skipped };
});

export const writeReviewPages = Effect.fnUntraced(function* (dir: string, events: readonly unknown[], variants: readonly ReviewVariant[]) {
  const fs = yield* FileSystem.FileSystem;
  const { pages, skipped } = yield* renderReviewPages(dir, events, variants);
  const written = pages.map((page) => ({ path: join(dir, page.file), html: page.html }));
  for (const page of written) yield* fs.writeFileString(page.path, page.html).pipe(Effect.mapError(failed));
  return { paths: written.map((page) => page.path), skipped } satisfies ReviewPagesResult;
});
