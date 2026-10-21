import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { command } from "../bench/timelineReplay.ts";
import { ReplayItem } from "../bench/sttReplay.ts";
import { runCommand, temporaryDirectory } from "./benchRun.ts";

describe("台本変換CLI", () => {
  it.effect("位置引数とselfを読み、sttReplayが読めるJSON配列を標準出力へ出す", () => Effect.gen(function* () {
    const dir = yield* temporaryDirectory;
    const file = join(dir, "timeline.tsv");
    writeFileSync(file, "司会\t0\t1\t開始\n甲\t1\t2\t提案\n");
    const { result, stdout, stderr } = yield* runCommand(command, [file, "--self", "司会"]);
    expect(result._tag).toBe("Success");
    expect(stderr).toBe("");
    const items = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(ReplayItem)))(stdout);
    expect(items).toHaveLength(2);
    expect(items.map(({ track, speaker }) => [track, speaker])).toEqual([["自分", undefined], ["相手", "相手 A"]]);
  }).pipe(Effect.scoped));
});
