import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Result } from "effect";
import { REVIEW_AUDIO_ELEMENT_ID, REVIEW_LICENSES_ELEMENT_ID, REVIEW_LOG_ELEMENT_ID, embedReviewAudio, embedReviewLicenses, embedReviewLog, makeSession, reviewSnapshot, type LogEvent, type Op, type Remark } from "../src/core/index.ts";
import { ReviewBuild, ReviewPageFailed, writeReviewPages } from "../src/review.ts";
import { reviewVariants } from "../src/sessionFiles.ts";
import { embeddedAudio, fakeAudioMix, FAKE_MIX_BYTES } from "./fixtures/audioMix.ts";
import { collectLog, updaterLayer } from "./fixtures/sessionLayers.ts";

const TEMPLATE = "<!doctype html><html><head></head><body><div id=\"root\"></div></body></html>";

const temporaryDirectory = Effect.acquireRelease(
  Effect.tryPromise(() => mkdtemp(join(tmpdir(), "live-mindmap-review-test-"))),
  (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
);

// 埋め込んだ JSON 要素の中身を取り出す（ブラウザの textContent と同じく、タグの間の文字列そのもの）
function embeddedText(html: string): string {
  const match = new RegExp(`<script type="application/json" id="${REVIEW_LOG_ELEMENT_ID}">([\\s\\S]*?)</script>`).exec(html);
  if (!match) throw new Error("埋め込みの要素がありません");
  return match[1]!;
}

// 埋め込んだ <template> 要素の中身を、ブラウザが textContent で返すのと同じ文字列に戻す（タグの間の文字列を、実体参照を解いて返す）
function licensesTemplate(html: string): { raw: string; decoded: string } {
  const match = new RegExp(`<template id="${REVIEW_LICENSES_ELEMENT_ID}">([\\s\\S]*?)</template>`).exec(html);
  if (!match) throw new Error("ライセンスの要素がありません");
  const raw = match[1]!;
  return { raw, decoded: raw.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&") };
}

const fakeBuild = (build: () => Effect.Effect<string, ReviewPageFailed>) =>
  Effect.provideService(ReviewBuild, ReviewBuild.of({ build }));

const PLAIN = { file: "map.html", audio: false } as const;
const WITH_AUDIO = { file: "map-audio.html", audio: true } as const;

const remark = (id: string, text: string, extra: Partial<Remark> = {}): Remark => ({ id, track: "相手", start: 0, end: 5, text, ...extra });

// 発言と差分更新を通した本物のログ（at 付き JSONL 1 行ぶんの形）
const realisticEvents = Effect.fn("realisticEvents")(function* () {
  const ops: Op[] = [
    { op: "add", ref: "t1", parent: "root", kind: "議題", text: "採用", evidence: ["r1"] },
    { op: "add", ref: "t2", parent: "t1", kind: "論点", text: "面接は何回か", evidence: ["r2"] },
  ];
  const events: LogEvent[] = [];
  const session = yield* makeSession({ title: "定例" }).pipe(
    Effect.provide(Layer.merge(updaterLayer(() => Effect.succeed({ ops })), collectLog(events))),
  );
  yield* session.push(remark("r1", "採用の話をします"));
  yield* session.push(remark("r2", "面接は何回にしますか"));
  yield* session.idle;
  return { session, events: events.map((e, i) => JSON.parse(JSON.stringify({ at: `2026-10-07T00:00:0${i}.000Z`, ...e }))) as unknown[] };
});

describe("embedReviewLog", () => {
  it("出来事を <script type=\"application/json\"> に入れる。中身に生の < は 1 つも無く、JSON.parse すると元の出来事に戻る", () => {
    const events = [
      { type: "start", title: "</script><script>alert(1)</script>" },
      { type: "remark", remark: { id: "r1", text: "<!-- <b>&</b> -->" } },
    ];
    const html = embedReviewLog(TEMPLATE, events);

    const text = embeddedText(html);
    expect(text).not.toContain("<");
    expect(JSON.parse(text)).toEqual(events);
    // 発言の中の </script> で、要素が早く閉じない
    expect(html.match(/<script/g)).toHaveLength(1);
  });

  it("テンプレートの JS の文字列に </body> があっても、最後の本物の </body> の直前に入れ、JS の文字列は変えない", () => {
    const template = "<html><head><script type=\"module\">const s = \"</body>\";</script></head><body><div id=\"root\"></div></body></html>";
    const html = embedReviewLog(template, [{ type: "start", title: "t" }]);

    expect(html).toContain("const s = \"</body>\";</script></head>");
    expect(html.indexOf(`id="${REVIEW_LOG_ELEMENT_ID}"`)).toBeGreaterThan(html.indexOf("<div id=\"root\"></div>"));
    expect(html.endsWith("</script></body></html>")).toBe(true);
    expect(html.match(/<\/body>/g)).toHaveLength(2);
  });

  it("テンプレートに </body> が無ければ throw する", () => {
    expect(() => embedReviewLog("<html><head></head></html>", [])).toThrow();
  });
});

describe("embedReviewLicenses", () => {
  const LICENSES = "# Licenses\n\n## evil - 1.0.0 (MIT)\n\nPermission --> granted </body> </script> <!-- & &amp; &lt;b&gt; <template></template>\n";
  const SCRIPT_TEMPLATE = "<html><head><script type=\"module\">const s = \"</body>\";</script></head><body><div id=\"root\"></div></body></html>";

  it("文言を <template> に入れる。中身に生の < > は無く、実体参照を解くと元の文言そのままに戻る", () => {
    const html = embedReviewLicenses(SCRIPT_TEMPLATE, LICENSES);

    const { raw, decoded } = licensesTemplate(html);
    expect(raw).not.toMatch(/[<>]/);
    expect(decoded).toBe(LICENSES);
    expect(html.match(/<template/g)).toHaveLength(1);
  });

  it("文言の中の </body>・</script>・--> があっても、HTML の形を壊さず、続けて埋め込むログも最後の本物の </body> の直前に入る", () => {
    const events = [{ type: "start", title: "t" }];
    const withLicenses = embedReviewLicenses(SCRIPT_TEMPLATE, LICENSES);
    const html = embedReviewLog(withLicenses, events);

    expect(JSON.parse(embeddedText(html))).toEqual(events);
    expect(licensesTemplate(html).decoded).toBe(LICENSES);
    // 文言の要素はログの要素より前、本物の </body> の前
    const templateAt = html.indexOf(`<template id="${REVIEW_LICENSES_ELEMENT_ID}">`);
    expect(templateAt).toBeGreaterThan(html.indexOf("<div id=\"root\"></div>"));
    expect(html.indexOf(`id="${REVIEW_LOG_ELEMENT_ID}"`)).toBeGreaterThan(html.indexOf("</template>"));
    // テンプレートの JS の文字列は変わらず、</body> の数も増えない（文言の </body> は実体参照になっている）
    expect(html).toContain("const s = \"</body>\";</script></head>");
    expect(html.match(/<\/body>/g)).toHaveLength(2);
    expect(html.match(/<\/script>/g)).toHaveLength(2);
    expect(html.endsWith("</script></body></html>")).toBe(true);
    expect(html).not.toContain("-->");
  });

  it("テンプレートに </body> が無ければ throw する", () => {
    expect(() => embedReviewLicenses("<html><head></head></html>", LICENSES)).toThrow();
  });
});

describe("embedReviewAudio", () => {
  const SCRIPT_TEMPLATE = "<html><head><script type=\"module\">const s = \"</body>\";</script></head><body><div id=\"root\"></div></body></html>";

  it("base64 の音声を、REVIEW_AUDIO_ELEMENT_ID の要素として最後の </body> の直前に入れ、読み戻すと元のバイト列になる。テンプレートの JS の文字列は変えない", () => {
    const html = embedReviewAudio(SCRIPT_TEMPLATE, FAKE_MIX_BYTES.toString("base64"));

    expect(embeddedAudio(html)).toEqual(FAKE_MIX_BYTES);
    expect(html.indexOf(`id="${REVIEW_AUDIO_ELEMENT_ID}"`)).toBeGreaterThan(html.indexOf("<div id=\"root\"></div>"));
    expect(html).toContain("const s = \"</body>\";</script></head>");
    expect(html.match(/<\/body>/g)).toHaveLength(2);
    expect(html.endsWith("</body></html>")).toBe(true);
  });

  it("ログの要素と並べても、どちらも最後の本物の </body> の直前にあり、それぞれ読み戻せる。要素の id は別", () => {
    const events = [{ type: "start", title: "t" }];
    const html = embedReviewAudio(embedReviewLog(SCRIPT_TEMPLATE, events), FAKE_MIX_BYTES.toString("base64"));

    expect(JSON.parse(embeddedText(html))).toEqual(events);
    expect(embeddedAudio(html)).toEqual(FAKE_MIX_BYTES);
    expect(REVIEW_AUDIO_ELEMENT_ID).not.toBe(REVIEW_LOG_ELEMENT_ID);
    expect(html.match(/<\/body>/g)).toHaveLength(2);
  });

  it("テンプレートに </body> が無ければ throw する", () => {
    expect(() => embedReviewAudio("<html><head></head></html>", "AAAA")).toThrow();
  });
});

describe("reviewSnapshot", () => {
  // web の入口（main.tsx）が同期で呼ぶので、reviewSnapshot は Effect にせず同期の関数のまま保つ
  it.effect("ログの出来事から、元のセッションの最後の時点と同じマップ・「変わったこと」・根拠を同期で組み立てる", () =>
    Effect.gen(function* () {
      const { session, events } = yield* realisticEvents();
      const snapshot = reviewSnapshot(events);

      expect(snapshot).toEqual(yield* session.snapshot);
      expect(snapshot.nodes.map((n) => n.text)).toEqual(["定例", "採用", "面接は何回か"]);
      expect(snapshot.changes.length).toBeGreaterThan(0);
      expect(snapshot.remarks.map((r) => r.id)).toEqual(["r1", "r2"]);
    }));

  it.effect("取り込みの記録（知らない type）の行があっても、マップは変わらない", () =>
    Effect.gen(function* () {
      const { session, events } = yield* realisticEvents();
      const withIntake = [...events.slice(0, 2), { at: "2026-10-07T00:00:09.000Z", type: "intake", note: "x" }, ...events.slice(2)];

      expect(reviewSnapshot(withIntake)).toEqual(yield* session.snapshot);
    }));

  it("壊れたログ（start が無い・項目が壊れた行）では、今と同じく例外を投げる", () => {
    expect(() => reviewSnapshot([])).toThrow();
    expect(() => reviewSnapshot([{ type: "start", title: "定例" }, { type: "remark" }])).toThrow();
  });
});

describe("writeReviewPages", () => {
  it.effect("log.jsonl の出来事（空行は除く・行末の改行あり）を、版ごとに 1 つの HTML へ埋め込んで書き、パスを版の順に返す。ビルドは 1 回だけ", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const events = [{ at: "a", type: "start", title: "定例" }, { at: "b", type: "intake", note: "x" }];
    const logPath = join(dir, "log.jsonl");
    writeFileSync(logPath, `${JSON.stringify(events[0])}\n\n${JSON.stringify(events[1])}\n`);
    let builds = 0;

    const mix = fakeAudioMix();
    const { paths, skipped } = yield* writeReviewPages(dir, logPath, [PLAIN, { file: "second.html", audio: false }]).pipe(
      fakeBuild(() => Effect.sync(() => { builds++; return TEMPLATE; })),
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
      writeReviewPages(dir, logPath, [PLAIN]).pipe(fakeBuild(() => Effect.fail(new ReviewPageFailed({ message: "ビルドに失敗" }))), Effect.provide(fakeAudioMix().layer)),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(ReviewPageFailed);
      expect(result.failure.message).toContain("ビルドに失敗");
    }
    expect(existsSync(join(dir, "map.html"))).toBe(false);
  }));

  it.effect("読めない行があれば ReviewPageFailed にし、理由に行番号（空行を数える）を含める。HTML は書かない", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const logPath = join(dir, "log.jsonl");
    writeFileSync(logPath, `${JSON.stringify({ type: "start", title: "t" })}\n\n{broken\n`);

    const result = yield* Effect.result(writeReviewPages(dir, logPath, [PLAIN]).pipe(fakeBuild(() => Effect.succeed(TEMPLATE)), Effect.provide(fakeAudioMix().layer)));

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(ReviewPageFailed);
      expect(result.failure.message).toContain("3");
    }
    expect(existsSync(join(dir, "map.html"))).toBe(false);
  }));

  it.effect("テンプレートに </body> が無ければ ReviewPageFailed になる", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const logPath = join(dir, "log.jsonl");
    writeFileSync(logPath, `${JSON.stringify({ type: "start", title: "t" })}\n`);

    const result = yield* Effect.result(writeReviewPages(dir, logPath, [PLAIN]).pipe(fakeBuild(() => Effect.succeed("<html></html>")), Effect.provide(fakeAudioMix().layer)));

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
      fakeBuild(() => Effect.sync(() => { builds++; return TEMPLATE; })),
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

    yield* writeReviewPages(dir, logPath, [WITH_AUDIO]).pipe(fakeBuild(() => Effect.succeed(TEMPLATE)), Effect.provide(mix.layer));

    const out = mix.calls[0]!.out;
    expect(dirname(out)).not.toBe(dir);
    expect(existsSync(out)).toBe(false);
    expect(existsSync(dirname(out))).toBe(false);
  }));

  it.effect("mix が失敗したら、その版だけを諦める。map.html は書いてパスを返し、諦めた版と理由を skipped に返す（失敗にはしない）。一時フォルダは残らない", () => Effect.gen(function* () {
    const { dir, logPath } = yield* prepare;
    const mix = fakeAudioMix();
    mix.failure.reason = "録音を混ぜられない";

    const { paths, skipped } = yield* writeReviewPages(dir, logPath, [PLAIN, WITH_AUDIO]).pipe(fakeBuild(() => Effect.succeed(TEMPLATE)), Effect.provide(mix.layer));

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
      writeReviewPages(dir, logPath, [PLAIN, WITH_AUDIO]).pipe(fakeBuild(() => Effect.fail(new ReviewPageFailed({ message: "ビルドに失敗" }))), Effect.provide(mix.layer)),
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

    const result = yield* Effect.result(writeReviewPages(dir, logPath, [PLAIN, WITH_AUDIO]).pipe(fakeBuild(() => Effect.succeed(TEMPLATE)), Effect.provide(mix.layer)));

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
    expect(reviewVariants(yield* folder("log.jsonl", "相手.m4a"))).toEqual([PLAIN, WITH_AUDIO]);
    expect(reviewVariants(yield* folder("自分-2.m4a"))).toEqual([PLAIN, WITH_AUDIO]);
    expect(reviewVariants(yield* folder("相手-3.m4a", "自分.m4a"))).toEqual([PLAIN, WITH_AUDIO]);
  }));

  it.effect("録音が無ければ map.html だけ。録音ではない名前（map-audio.html・map.png など）・拡張子違い・サブフォルダの中の m4a は録音と数えない", () => Effect.gen(function* () {
    const dir = yield* folder("log.jsonl", "map.html", "map-audio.html", "map.png", "export.json", "メモ.m4a", "相手.txt");
    mkdirSync(join(dir, "相手"));
    writeFileSync(join(dir, "相手", "x.m4a"), "x");

    expect(reviewVariants(dir)).toEqual([PLAIN]);
    expect(reviewVariants(yield* folder())).toEqual([PLAIN]);
  }));
});
