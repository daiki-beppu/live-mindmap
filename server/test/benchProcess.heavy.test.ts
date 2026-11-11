import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { runScript, temporaryDirectory } from "./benchRun.ts";

describe("sttLatency.ts のプロセス", () => {
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
