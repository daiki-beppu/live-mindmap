import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { command } from "../bench/sttAccuracy.ts";
import { runCommand, taggedFailure, temporaryDirectory } from "./benchRun.ts";

describe("sttAccuracy の Command", () => {
  it.effect("stt-bench の JSONL は確定結果だけを、kanary の JSON は segments を発言として採点する", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const timeline = join(dir, "timeline.tsv");
    const terms = join(dir, "terms.txt");
    const jsonl = join(dir, "results.jsonl");
    const kanary = join(dir, "meeting.transcript.json");
    writeFileSync(timeline, "真壁\t0.00\t3.00\tOJT です。\n");
    writeFileSync(terms, "OJT\n");
    writeFileSync(jsonl, [
      { track: "相手", arrival: 1, isFinal: false, start: 0, end: 2, text: "OT" },
      { track: "相手", arrival: 4, isFinal: true, start: 0, end: 3, text: "OJTです。" },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");
    writeFileSync(kanary, JSON.stringify({ transcript: { segments: [{ track: "speaker", start_seconds: 0, end_seconds: 3, text: "OTです" }] } }));

    const fromBench = yield* runCommand(command, [timeline, jsonl, "--terms", terms]);
    expect(fromBench.result._tag).toBe("Success");
    expect(fromBench.stdout).toContain("| 5 | 0.0% | 0 | 0 | 0 |");
    expect(fromBench.stdout).toContain("固有名詞・略語の正解率: 100.0%（1/1）。かなの違いだけのもの: 0");

    const fromKanary = yield* runCommand(command, [timeline, kanary, "--terms", terms]);
    expect(fromKanary.stdout).toContain("| 5 | 20.0% | 0 | 1 | 0 |");
    expect(fromKanary.stdout).toContain("| OJT | 0 | 0 | 1 | ot（1） |");
  }).pipe(Effect.scoped));

  it.effect("発言のファイルの形が違えば、パス付きのタグ付きの失敗にする", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const timeline = join(dir, "timeline.tsv");
    const broken = join(dir, "broken.jsonl");
    writeFileSync(timeline, "真壁\t0.00\t3.00\tOJT です。\n");
    writeFileSync(broken, "{\"text\": 1}\n");
    const { result } = yield* runCommand(command, [timeline, broken]);
    expect(taggedFailure(result)).toMatchObject({ _tag: "InvalidInputFile", path: broken });
  }).pipe(Effect.scoped));

  it.effect("--settle は途中結果と確定結果を settle に通した発言で採点し、全文の送り直しが重ならない", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const timeline = join(dir, "timeline.tsv");
    const jsonl = join(dir, "results.jsonl");
    writeFileSync(timeline, "真壁\t0.00\t5.00\tあいうえお\n");
    // 同じ start で全文を送り直す途中結果。end の間隔は 1 秒以上あり、それぞれが発言として出る
    writeFileSync(jsonl, [
      { track: "相手", arrival: 0, isFinal: false, start: 0, end: 2, text: "あい" },
      { track: "相手", arrival: 2, isFinal: false, start: 0, end: 4, text: "あいうえ" },
      { track: "相手", arrival: 4, isFinal: false, start: 0, end: 5, text: "あいうえお" },
      { track: "相手", arrival: 10, isFinal: true, start: 0, end: 5, text: "あいうえお" },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");

    const finalOnly = yield* runCommand(command, [timeline, jsonl]);
    expect(finalOnly.stdout).toContain("| 5 | 0.0% | 0 | 0 | 0 |");

    const settled = yield* runCommand(command, [timeline, jsonl, "--settle"]);
    expect(settled.result._tag).toBe("Success");
    expect(settled.stdout).toContain("| 5 | 0.0% | 0 | 0 | 0 |");
  }).pipe(Effect.scoped));

  it.effect("--settle は確定結果の end が 1 秒の期限の前か後かで採点が変わる（到着の時刻ではなく end で測る）", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const timeline = join(dir, "timeline.tsv");
    writeFileSync(timeline, "真壁\t0.00\t3.00\tあいう\n");
    const run = (name: string, finalEnd: number, finalArrival: number) => {
      const jsonl = join(dir, `results-${name}.jsonl`);
      writeFileSync(jsonl, [
        { track: "相手", arrival: 0, isFinal: false, start: 0, end: 2, text: "あい" },
        { track: "相手", arrival: finalArrival, isFinal: true, start: 0, end: finalEnd, text: "あいう" },
      ].map((r) => JSON.stringify(r)).join("\n") + "\n");
      return runCommand(command, [timeline, jsonl, "--settle"]);
    };

    // 途中結果（end 2）の期限は 3 秒。確定結果の end が 2.5 なら期限の前で、途中結果は出ず確定結果が出る
    const before = yield* run("before", 2.5, 5);
    expect(before.stdout).toContain("| 3 | 0.0% | 0 | 0 | 0 |");
    // 確定結果の end が 3 なら期限に届いていて、途中結果「あい」が先に出る
    const after = yield* run("after", 3, 5);
    expect(after.stdout).toContain("| 3 | 33.3% | 0 | 1 | 0 |");
  }).pipe(Effect.scoped));

  it.effect("--settle は到着の時刻の間隔に依らない: 同じ結果の列を詰めても延ばしても、採点は同じ", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const timeline = join(dir, "timeline.tsv");
    writeFileSync(timeline, "真壁\t0.00\t3.00\tあいう\n");
    const run = (name: string, arrivals: readonly [number, number]) => {
      const jsonl = join(dir, `results-${name}.jsonl`);
      writeFileSync(jsonl, [
        { track: "相手", arrival: arrivals[0], isFinal: false, start: 0, end: 2, text: "あい" },
        { track: "相手", arrival: arrivals[1], isFinal: true, start: 0, end: 2.5, text: "あいう" },
      ].map((r) => JSON.stringify(r)).join("\n") + "\n");
      return runCommand(command, [timeline, jsonl, "--settle"]);
    };

    const compressed = yield* run("compressed", [0, 0.1]);
    const stretched = yield* run("stretched", [0, 60]);

    expect(compressed.stdout).toContain("| 3 | 0.0% | 0 | 0 | 0 |");
    expect(stretched.stdout).toBe(compressed.stdout);
  }).pipe(Effect.scoped));

  it.effect("--settle は確定結果が来ない途中結果からも発言を作って採点する（付けなければ脱落になる）", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const timeline = join(dir, "timeline.tsv");
    const jsonl = join(dir, "results.jsonl");
    writeFileSync(timeline, "真壁\t0.00\t3.00\tあいう\n真壁\t4.00\t7.00\tえおか\n");
    writeFileSync(jsonl, [
      { track: "相手", arrival: 3, isFinal: true, start: 0, end: 3, text: "あいう" },
      { track: "相手", arrival: 5, isFinal: false, start: 4, end: 7, text: "えおか" },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");

    const finalOnly = yield* runCommand(command, [timeline, jsonl]);
    expect(finalOnly.stdout).toContain("| 6 | 50.0% | 0 | 3 | 0 |");
    const settled = yield* runCommand(command, [timeline, jsonl, "--settle"]);
    expect(settled.stdout).toContain("| 6 | 0.0% | 0 | 0 | 0 |");
  }).pipe(Effect.scoped));

  it.effect("kanary の JSON に --settle を付けると、パス付きのタグ付きの失敗にする", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const timeline = join(dir, "timeline.tsv");
    const kanary = join(dir, "meeting.transcript.json");
    writeFileSync(timeline, "真壁\t0.00\t3.00\tOJT です。\n");
    writeFileSync(kanary, JSON.stringify({ transcript: { segments: [{ track: "speaker", start_seconds: 0, end_seconds: 3, text: "OTです" }] } }));
    const { result } = yield* runCommand(command, [timeline, kanary, "--settle"]);
    expect(taggedFailure(result)).toMatchObject({ _tag: "InvalidInputFile", path: kanary });
  }).pipe(Effect.scoped));
});
