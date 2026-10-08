// bench のスクリプトをプロセスとして走らせる。argv が入口まで届くこと・失敗の 1 行・exit code・--help を、実際の経路で確かめる
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { formatRow, parseLog, sessionStats } from "../bench/sessionStats.ts";
import { summarize, type SttResult } from "../bench/sttLatency.ts";
import { runScript, temporaryDirectory } from "./benchRun.ts";

const results: SttResult[] = [
  { track: "相手", arrival: 5, isFinal: false, start: 0, end: 5, text: "あ" },
  { track: "相手", arrival: 20, isFinal: true, start: 0, end: 8, text: "あいう。" },
];
const logText = [
  JSON.stringify({ type: "remark", remark: { id: "r1", track: "相手", start: 0, end: 4, text: "本文" } }),
  JSON.stringify({ type: "diff", ops: [{}], dropped: [] }),
].join("\n") + "\n";

describe.each(["sttLatency.ts", "sttReplay.ts", "sessionStats.ts"])("bench/%s のプロセス入口", (script) => {
  it.live("--help は使い方を stdout に出して exit 0（stderr は空）", () => Effect.gen(function* () {
    const r = yield* runScript(script, ["--help"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(r.stdout).toMatch(/Usage|USAGE/);
  }));

  it.live("位置引数が無ければ、help と ERROR を出して exit 1（stack trace は出さない）", () => Effect.gen(function* () {
    const r = yield* runScript(script, []);
    expect(r.code).toBe(1);
    expect(r.stderr.split("\n").filter((l) => /^ERROR\b/.test(l))).toHaveLength(1);
    expect(r.stderr).not.toMatch(/\n\s+at /);
  }));
});

describe("sttLatency.ts のプロセス", () => {
  it.live("正しい呼び方で、集計の表をバイト単位で今と同じに出す", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const file = join(dir, "results.jsonl");
    writeFileSync(file, results.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const r = yield* runScript("sttLatency.ts", [file, "--quiet", "1"]);
    expect(r).toEqual({ code: 0, stdout: summarize(results, 1), stderr: "" });
  }).pipe(Effect.scoped));

  it.live("結果ファイルが壊れていれば、stderr に「<パス>: <理由>」の 1 行だけを出して exit 1", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const file = join(dir, "broken.jsonl");
    writeFileSync(file, "{ not json\n");
    const r = yield* runScript("sttLatency.ts", [file]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr.endsWith("\n")).toBe(true);
    const lines = r.stderr.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.startsWith(`${file}: 入力ファイルを読めないか、形が違います（`)).toBe(true);
    expect(lines[0]!.endsWith("）")).toBe(true);
  }).pipe(Effect.scoped));
});

describe("sessionStats.ts のプロセス", () => {
  it.live("正しい呼び方で、行をバイト単位で今と同じに出す（% を含む）", () => Effect.gen(function* () {
    const root = yield* temporaryDirectory;
    const dir = join(root, "run-a");
    mkdirSync(dir);
    writeFileSync(join(dir, "log.jsonl"), logText);
    const expected = formatRow("run-a", sessionStats(yield* parseLog(logText)), null).join("\n") + "\n";
    const r = yield* runScript("sessionStats.ts", [dir, "--no-audio"]);
    expect(r).toEqual({ code: 0, stdout: expected, stderr: "" });
    expect(r.stdout).toContain("%");
  }).pipe(Effect.scoped));

  it.live("セッションのフォルダが無ければ、stderr に「<パス>: <理由>」の 1 行だけを出して exit 1", () => Effect.gen(function* () {
    const root = yield* temporaryDirectory;
    const missing = join(root, "missing");
    const r = yield* runScript("sessionStats.ts", [missing, "--no-audio"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    const lines = r.stderr.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]!.startsWith(`${missing}: セッションのフォルダが無いか、読めません（`)).toBe(true);
    expect(lines[0]!.endsWith("）")).toBe(true);
  }).pipe(Effect.scoped));
});
