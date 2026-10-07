import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { InvalidTruthFile, readTruthFile } from "../src/truthFile.ts";
import { temporaryDirectory } from "./benchRun.ts";

// cli の eval --truth と bench の sttReplay --truth が共有する、正解ファイルの読み込み
describe("正解ファイルを読む（cli と bench の共有）", () => {
  it.effect("正しいファイルは Truth として読める", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const path = join(dir, "ok.truth.json");
    const truth = { 決定: [], TODO: [{ from: 1, to: 2, keywords: [["求人", "採用"]] }] };
    writeFileSync(path, JSON.stringify(truth));
    expect(yield* readTruthFile(path)).toEqual(truth);
  }).pipe(Effect.scoped));

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
  }).pipe(Effect.scoped));

  it.effect("形の誤りの理由は、人が直せる日本語（種別と件目つき）。cli の出力と同じ文面", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const path = join(dir, "bad.truth.json");
    writeFileSync(path, JSON.stringify({ 決定: [{ text: "x", from: 5, to: 2, keywords: ["x"] }], TODO: [] }));
    const failure = yield* Effect.flip(readTruthFile(path));
    expect(failure.reason).toBe("「決定」の 1 件目: from が to より大きい");
  }).pipe(Effect.scoped));

  it.effect("読めないファイル（無い）も InvalidTruthFile で、理由に読めなかった原因が入る", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const path = join(dir, "missing.truth.json");
    const failure = yield* Effect.flip(readTruthFile(path));
    expect(failure._tag).toBe("InvalidTruthFile");
    expect(failure.path).toBe(path);
    expect(failure.reason).toContain("ENOENT");
  }).pipe(Effect.scoped));
});
