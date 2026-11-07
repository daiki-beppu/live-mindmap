import { basename, join } from "node:path";
import { Effect, FileSystem } from "effect";
import { readLogLines } from "../src/sessionFiles.ts";
import { InvalidInputFile, write } from "./entry.ts";

export const judgeSessions = Effect.fnUntraced(function* <A, E extends { readonly message: string }, R>(
  paths: ReadonlyArray<string>,
  spec: {
    readonly header: string;
    readonly output: string;
    readonly judge: (events: ReadonlyArray<unknown>) => Effect.Effect<A, E, R>;
    readonly saved?: (result: A) => unknown;
    readonly row: (session: string, result: A) => string;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  yield* write(spec.header);
  for (const dir of paths) {
    const path = join(dir, "log.jsonl");
    const { events } = yield* readLogLines(path).pipe(
      Effect.mapError((error) => new InvalidInputFile({
        path, reason: error._tag === "BrokenLogLine" ? `行 ${error.line} のJSONが不正です` : "ログの読込に失敗しました",
      })),
    );
    const result = yield* spec.judge(events).pipe(
      Effect.mapError((error) => new InvalidInputFile({ path, reason: error.message })),
    );
    const output = join(dir, spec.output);
    yield* fs.writeFileString(output, JSON.stringify(spec.saved ? spec.saved(result) : result)).pipe(
      Effect.mapError(() => new InvalidInputFile({ path: output, reason: "判定結果の保存に失敗しました" })),
    );
    yield* write(spec.row(basename(dir), result));
  }
});
