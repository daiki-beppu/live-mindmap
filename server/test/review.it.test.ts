import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { ReviewBuild, ReviewPageFailed, writeReviewPages } from "../src/review.ts";
import { reviewVariants, selfReviewVariants } from "../src/sessionFiles.ts";
import { embeddedAudio, fakeAudioMix, FAKE_MIX_BYTES } from "./fixtures/audioMix.ts";
import { embeddedText, TEMPLATE } from "./fixtures/review.ts";

// 書き出し（writeReviewPages）が、本物のファイルシステムで HTML・音声を書くこと。ビルドだけ偽物にする。埋め込み単体の確認は review.test.ts

const temporaryDirectory = Effect.acquireRelease(
  Effect.tryPromise(() => mkdtemp(join(tmpdir(), "live-mindmap-review-test-"))),
  (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
);

// 書き出し（ログの読み込み・HTML の書き込み・mix の一時フォルダ）は本物の FileSystem で、ビルドだけ偽物にする
const fakeBuild = (build: Effect.Effect<string, ReviewPageFailed>) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    self.pipe(Effect.provideService(ReviewBuild, ReviewBuild.of({ build })), Effect.provide(NodeFileSystem.layer));

const PLAIN = { file: "map.html", audio: false } as const;
const WITH_AUDIO = { file: "map-audio.html", audio: true } as const;

describe("writeReviewPages", () => {
  it.effect("log.jsonl の出来事（空行は除く・行末の改行あり）を、版ごとに 1 つの HTML へ埋め込んで書き、パスを版の順に返す。ビルドは 1 回だけ", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const events = [{ at: "a", type: "start", title: "定例" }, { at: "b", type: "intake", note: "x" }];
    const logPath = join(dir, "log.jsonl");
    writeFileSync(logPath, `${JSON.stringify(events[0])}\n\n${JSON.stringify(events[1])}\n`);
    let builds = 0;

    const mix = fakeAudioMix();
    const { paths, skipped } = yield* writeReviewPages(dir, logPath, [PLAIN, { file: "second.html", audio: false }]).pipe(
      fakeBuild(Effect.sync(() => { builds++; return TEMPLATE; })),
      Effect.provide(mix.layer),
    );

    expect(skipped).toEqual([]);
    expect(mix.calls).toEqual([]); // 音声を混ぜない版だけなら、mix は呼ばない
    expect(paths).toEqual([join(dir, "map.html"), join(dir, "second.html")]);
    expect(builds).toBe(1);
    for (const path of paths) {
      const html = yield* Effect.tryPromise(() => readFile(path, "utf8"));
      expect(JSON.parse(embeddedText(html))).toEqual(events);
    }
  }));

  it.effect("ビルドが失敗したら ReviewPageFailed になり、何も書かない", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const logPath = join(dir, "log.jsonl");
    writeFileSync(logPath, `${JSON.stringify({ type: "start", title: "t" })}\n`);

    const result = yield* Effect.result(
      writeReviewPages(dir, logPath, [PLAIN]).pipe(fakeBuild(Effect.fail(new ReviewPageFailed({ message: "ビルドに失敗" }))), Effect.provide(fakeAudioMix().layer)),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(ReviewPageFailed);
      expect(result.failure.message).toContain("ビルドに失敗");
    }
    expect(existsSync(join(dir, "map.html"))).toBe(false);
  }));

  it.effect("読めない行があれば ReviewPageFailed にし、「<path> の <n> 行目が JSON として読めません: <1 行の理由>」とする。行番号は空行を除く前に数える。HTML は書かない", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const logPath = join(dir, "log.jsonl");
    writeFileSync(logPath, `${JSON.stringify({ type: "start", title: "t" })}\n\n{broken\n`);

    const result = yield* Effect.result(writeReviewPages(dir, logPath, [PLAIN]).pipe(fakeBuild(Effect.succeed(TEMPLATE)), Effect.provide(fakeAudioMix().layer)));

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(ReviewPageFailed);
      const prefix = `${logPath} の 3 行目が JSON として読めません: `;
      expect(result.failure.message.startsWith(prefix)).toBe(true);
      expect(result.failure.message.slice(prefix.length)).toMatch(/^[^\n]+$/);
    }
    expect(existsSync(join(dir, "map.html"))).toBe(false);
  }));

  it.effect("テンプレートに </body> が無ければ ReviewPageFailed になる", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const logPath = join(dir, "log.jsonl");
    writeFileSync(logPath, `${JSON.stringify({ type: "start", title: "t" })}\n`);

    const result = yield* Effect.result(writeReviewPages(dir, logPath, [PLAIN]).pipe(fakeBuild(Effect.succeed("<html></html>")), Effect.provide(fakeAudioMix().layer)));

    expect(Result.isFailure(result) && result.failure instanceof ReviewPageFailed).toBe(true);
    expect(existsSync(join(dir, "map.html"))).toBe(false);
  }));
});


describe("writeReviewPages の音声つきの版", () => {
  const prepare = Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const logPath = join(dir, "log.jsonl");
    const events = [{ at: "a", type: "start", title: "定例" }];
    writeFileSync(logPath, `${JSON.stringify(events[0])}\n`);
    return { dir, logPath, events };
  });
  const read = (path: string) => Effect.tryPromise(() => readFile(path, "utf8"));

  it.effect("音声つきの版には mix の出力を base64 で埋め込む。ログも入り、音声なしの版には音声を入れない。パスは版の順", () => Effect.gen(function* () {
    const { dir, logPath, events } = yield* prepare;
    const mix = fakeAudioMix();
    let builds = 0;

    const { paths, skipped } = yield* writeReviewPages(dir, logPath, [PLAIN, WITH_AUDIO]).pipe(
      fakeBuild(Effect.sync(() => { builds++; return TEMPLATE; })),
      Effect.provide(mix.layer),
    );

    expect(paths).toEqual([join(dir, "map.html"), join(dir, "map-audio.html")]);
    expect(skipped).toEqual([]);
    expect(builds).toBe(1);
    expect(mix.calls).toHaveLength(1);
    expect(mix.calls[0]!.session).toBe(dir);
    const audioHtml = yield* read(paths[1]!);
    expect(embeddedAudio(audioHtml)).toEqual(FAKE_MIX_BYTES);
    expect(JSON.parse(embeddedText(audioHtml))).toEqual(events);
    expect(embeddedAudio(yield* read(paths[0]!))).toBeNull();
  }));

  it.effect("mix の出力は一時フォルダに書かれ、セッションのフォルダには残らず、書き出しの後に一時フォルダも残らない", () => Effect.gen(function* () {
    const { dir, logPath } = yield* prepare;
    const mix = fakeAudioMix();

    yield* writeReviewPages(dir, logPath, [WITH_AUDIO]).pipe(fakeBuild(Effect.succeed(TEMPLATE)), Effect.provide(mix.layer));

    const out = mix.calls[0]!.out;
    expect(dirname(out)).not.toBe(dir);
    expect(existsSync(out)).toBe(false);
    expect(existsSync(dirname(out))).toBe(false);
  }));

  it.effect("mix が失敗したら、その版だけを諦める。map.html は書いてパスを返し、諦めた版と理由を skipped に返す（失敗にはしない）。一時フォルダは残らない", () => Effect.gen(function* () {
    const { dir, logPath } = yield* prepare;
    const mix = fakeAudioMix();
    mix.failure.reason = "録音を混ぜられない";

    const { paths, skipped } = yield* writeReviewPages(dir, logPath, [PLAIN, WITH_AUDIO]).pipe(fakeBuild(Effect.succeed(TEMPLATE)), Effect.provide(mix.layer));

    expect(paths).toEqual([join(dir, "map.html")]);
    expect(skipped).toEqual([{ file: "map-audio.html", reason: "録音を混ぜられない" }]);
    expect(existsSync(join(dir, "map.html"))).toBe(true);
    expect(existsSync(join(dir, "map-audio.html"))).toBe(false);
    expect(existsSync(dirname(mix.calls[0]!.out))).toBe(false);
  }));

  it.effect("ビルドが失敗したら、音声つきの版があっても何も書かず ReviewPageFailed になり、mix は呼ばない", () => Effect.gen(function* () {
    const { dir, logPath } = yield* prepare;
    const mix = fakeAudioMix();

    const result = yield* Effect.result(
      writeReviewPages(dir, logPath, [PLAIN, WITH_AUDIO]).pipe(fakeBuild(Effect.fail(new ReviewPageFailed({ message: "ビルドに失敗" }))), Effect.provide(mix.layer)),
    );

    expect(Result.isFailure(result) && result.failure instanceof ReviewPageFailed).toBe(true);
    expect(existsSync(join(dir, "map.html"))).toBe(false);
    expect(existsSync(join(dir, "map-audio.html"))).toBe(false);
    expect(mix.calls).toEqual([]);
  }));

  it.effect("ログが読めなければ、音声つきの版があっても何も書かず ReviewPageFailed になり、mix は呼ばない", () => Effect.gen(function* () {
    const { dir, logPath } = yield* prepare;
    writeFileSync(logPath, "{broken\n");
    const mix = fakeAudioMix();

    const result = yield* Effect.result(writeReviewPages(dir, logPath, [PLAIN, WITH_AUDIO]).pipe(fakeBuild(Effect.succeed(TEMPLATE)), Effect.provide(mix.layer)));

    expect(Result.isFailure(result) && result.failure instanceof ReviewPageFailed).toBe(true);
    expect(existsSync(join(dir, "map.html"))).toBe(false);
    expect(mix.calls).toEqual([]);
  }));
});

describe("reviewVariants（録音の有無で版の一覧を決める）", () => {
  const folder = (...files: string[]) => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    for (const name of files) writeFileSync(join(dir, name), "x");
    return dir;
  });

  it.effect("相手*.m4a・自分*.m4a があれば、map.html、map-audio.html の順。音声を混ぜるのは map-audio.html だけ", () => Effect.gen(function* () {
    expect(yield* reviewVariants(yield* folder("log.jsonl", "相手.m4a"))).toEqual([PLAIN, WITH_AUDIO]);
    expect(yield* reviewVariants(yield* folder("自分-2.m4a"))).toEqual([PLAIN, WITH_AUDIO]);
    expect(yield* reviewVariants(yield* folder("相手-3.m4a", "自分.m4a"))).toEqual([PLAIN, WITH_AUDIO]);
  }).pipe(Effect.provide(NodeFileSystem.layer)));

  it.effect("録音が無ければ map.html だけ。録音ではない名前（map-audio.html・map.png など）・拡張子違い・サブフォルダの中の m4a は録音と数えない", () => Effect.gen(function* () {
    const dir = yield* folder("log.jsonl", "map.html", "map-audio.html", "map.png", "export.json", "メモ.m4a", "相手.txt");
    mkdirSync(join(dir, "相手"));
    writeFileSync(join(dir, "相手", "x.m4a"), "x");
    mkdirSync(join(dir, "自分.m4a")); // 名前が録音の形でも、フォルダは録音ではない

    expect(yield* reviewVariants(dir)).toEqual([PLAIN]);
    expect(yield* reviewVariants(yield* folder())).toEqual([PLAIN]);
  }).pipe(Effect.provide(NodeFileSystem.layer)));

  it.effect("シンボリックリンクは録音と数えない（通常ファイルへのリンクも、リンク先が無いリンクも。失敗しない）", () => Effect.gen(function* () {
    const toFile = yield* folder("実体.txt");
    symlinkSync(join(toFile, "実体.txt"), join(toFile, "自分.m4a"));
    expect(yield* reviewVariants(toFile)).toEqual([PLAIN]);
    const dangling = yield* folder();
    symlinkSync(join(dangling, "無い.m4a"), join(dangling, "相手.m4a"));
    expect(yield* reviewVariants(dangling)).toEqual([PLAIN]);
  }).pipe(Effect.provide(NodeFileSystem.layer)));
});

describe("selfReviewVariants（自分の声だけの版）", () => {
  const SELF = { file: "map-audio-自分.html", audio: true, track: "自分" };
  const folder = (...files: string[]) => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    for (const name of files) writeFileSync(join(dir, name), "x");
    return dir;
  });

  it.effect("自分*.m4a があれば 1 つ。無ければ空（相手だけの録音・フォルダ・拡張子違いは数えない）", () => Effect.gen(function* () {
    expect(yield* selfReviewVariants(yield* folder("自分.m4a", "相手.m4a"))).toEqual([SELF]);
    expect(yield* selfReviewVariants(yield* folder("自分-2.m4a"))).toEqual([SELF]);
    expect(yield* selfReviewVariants(yield* folder("相手.m4a", "自分.txt"))).toEqual([]);
    const dir = yield* folder();
    mkdirSync(join(dir, "自分.m4a"));
    expect(yield* selfReviewVariants(dir)).toEqual([]);
  }).pipe(Effect.provide(NodeFileSystem.layer)));

  it.effect("シンボリックリンクは録音と数えない（通常ファイルへのリンクも、リンク先が無いリンクも。失敗しない）", () => Effect.gen(function* () {
    const toFile = yield* folder("実体.txt");
    symlinkSync(join(toFile, "実体.txt"), join(toFile, "自分.m4a"));
    expect(yield* selfReviewVariants(toFile)).toEqual([]);
    const dangling = yield* folder();
    symlinkSync(join(dangling, "無い.m4a"), join(dangling, "自分.m4a"));
    expect(yield* selfReviewVariants(dangling)).toEqual([]);
  }).pipe(Effect.provide(NodeFileSystem.layer)));
});
