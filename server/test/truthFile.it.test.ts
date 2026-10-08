import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { NodeFileSystem } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { InvalidTruthFile, readScreenTruthFile, readTextFile, readTruthFile } from "../src/truthFile.ts";
import { temporaryDirectory } from "./benchRun.ts";

// 読み込みの下地。失敗は文字列ではなく PlatformError で表し、呼び出し側が自分のタグ付きの失敗に包む
describe("readTextFile", () => {
  it.effect("読めたら中身の文字列を返す", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const path = join(dir, "a.txt");
    writeFileSync(path, "中身\n");
    expect(yield* readTextFile(path)).toBe("中身\n");
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)));

  it.effect("読めないファイル（無い）は PlatformError で失敗する", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const failure = yield* Effect.flip(readTextFile(join(dir, "missing.txt")));
    expect(failure._tag).toBe("PlatformError");
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)));
});

// cli の eval --truth と bench の sttReplay --truth が共有する、正解ファイルの読み込み
describe("正解ファイルを読む（cli と bench の共有）", () => {
  it.effect("正しいファイルは Truth として読める", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const path = join(dir, "ok.truth.json");
    const truth = { 決定: [], TODO: [{ from: 1, to: 2, keywords: [["求人", "採用"]] }] };
    writeFileSync(path, JSON.stringify(truth));
    expect(yield* readTruthFile(path)).toEqual(truth);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)));

  it.effect.each([
    { name: "JSON 構文", content: "{ not json" },
    { name: "入れ物が配列", content: "[]" },
    { name: "種別のキーが無い", content: JSON.stringify({ TODO: [] }) },
  ])("壊れたファイル（$name）は、パスと 1 行の理由を持つ InvalidTruthFile で失敗する", ({ content }) => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const path = join(dir, "bad.truth.json");
    writeFileSync(path, content);
    const failure = yield* Effect.flip(readTruthFile(path));
    expect(failure).toBeInstanceOf(InvalidTruthFile);
    expect(failure._tag).toBe("InvalidTruthFile");
    expect(failure.path).toBe(path);
    expect(failure.reason).not.toBe("");
    expect(failure.reason).not.toMatch(/\n/);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)));

  it.effect("形の誤りの理由は、人が直せる日本語（種別と件目つき）。cli の出力と同じ文面", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const path = join(dir, "bad.truth.json");
    writeFileSync(path, JSON.stringify({ 決定: [{ text: "x", from: 5, to: 2, keywords: ["x"] }], TODO: [] }));
    const failure = yield* Effect.flip(readTruthFile(path));
    expect(failure.reason).toBe("「決定」の 1 件目: from が to より大きい");
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)));

  it.effect("読めないファイル（無い）も InvalidTruthFile で、理由に読めなかった原因が入る", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const path = join(dir, "missing.truth.json");
    const failure = yield* Effect.flip(readTruthFile(path));
    expect(failure._tag).toBe("InvalidTruthFile");
    expect(failure.path).toBe(path);
    expect(failure.reason).toContain("ENOENT");
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)));
});

// cli の eval --screen-truth が使う、共有画面の正解ファイルの読み込み
describe("共有画面の正解ファイルを読む", () => {
  const point = { from: 1, to: 2, keywords: ["求人"] };

  it.effect("正しいファイルは読める。memory と人が読む項目は省略でき、出てはいけないは from / to を持たない", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const path = join(dir, "ok.screen.truth.json");
    const truth = {
      指す発言: [{ ...point, memory: true, speaker: "A", remark: "r", shown: "s", slide: "p", text: "t" }, point],
      話だけ: [{ ...point, keywords: [["求人", "採用"], "票"] }],
      出てはいけない: [{ keywords: ["x"] }, { text: "t", slide: "p", keywords: [["a", "b"]] }],
    };
    writeFileSync(path, JSON.stringify(truth));
    expect(yield* readScreenTruthFile(path)).toEqual(truth);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)));

  it.effect.each([
    { name: "JSON 構文", content: "{ not json" },
    { name: "入れ物が配列", content: "[]" },
    { name: "出てはいけないのキーが無い", content: JSON.stringify({ 指す発言: [], 話だけ: [] }) },
    { name: "出てはいけないが配列でない", content: JSON.stringify({ 指す発言: [], 話だけ: [], 出てはいけない: {} }) },
    { name: "出てはいけないの項目がオブジェクトでない", content: JSON.stringify({ 指す発言: [], 話だけ: [], 出てはいけない: [1] }) },
  ])("壊れたファイル（$name）は、パスと 1 行の理由を持つ InvalidTruthFile で失敗する", ({ content }) => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const path = join(dir, "bad.screen.truth.json");
    writeFileSync(path, content);
    const failure = yield* Effect.flip(readScreenTruthFile(path));
    expect(failure).toBeInstanceOf(InvalidTruthFile);
    expect(failure._tag).toBe("InvalidTruthFile");
    expect(failure.path).toBe(path);
    expect(failure.reason).not.toBe("");
    expect(failure.reason).not.toMatch(/\n/);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)));

  it.effect.each([
    { name: "話だけが配列でない", truth: { 指す発言: [], 話だけ: "x", 出てはいけない: [] }, reason: "「話だけ」は配列で書く" },
    { name: "出てはいけないのキーワードが空", truth: { 指す発言: [], 話だけ: [], 出てはいけない: [{ keywords: [] }] }, reason: "「出てはいけない」の 1 件目: keywords は 1 件以上の配列で書く（要素は文字列か、文字列の配列）" },
    { name: "出てはいけないのキーワードが空文字", truth: { 指す発言: [], 話だけ: [], 出てはいけない: [{ keywords: ["ok"] }, { keywords: [" "] }] }, reason: "「出てはいけない」の 2 件目: keywords は 1 件以上の配列で書く（要素は文字列か、文字列の配列）" },
    { name: "指す発言の from が to より大きい", truth: { 指す発言: [{ ...point, from: 5, to: 2 }], 話だけ: [], 出てはいけない: [] }, reason: "「指す発言」の 1 件目: from が to より大きい" },
  ])("形の誤りの理由は、キーと件目つきの日本語 1 行（$name）", ({ truth, reason }) => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const path = join(dir, "bad.screen.truth.json");
    writeFileSync(path, JSON.stringify(truth));
    const failure = yield* Effect.flip(readScreenTruthFile(path));
    expect(failure.reason).toBe(reason);
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)));

  it.effect("読めないファイル（無い）も InvalidTruthFile で、理由に読めなかった原因が入る", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const path = join(dir, "missing.screen.truth.json");
    const failure = yield* Effect.flip(readScreenTruthFile(path));
    expect(failure._tag).toBe("InvalidTruthFile");
    expect(failure.path).toBe(path);
    expect(failure.reason).toContain("ENOENT");
  }).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer)));
});
