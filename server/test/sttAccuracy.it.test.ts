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
});
