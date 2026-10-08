// log.jsonl を 1 行ずつ JSON として読む。cli（play・restore・eval）と review が共有する。
// sessionFiles.ts は review.ts を import しているので、循環を避けるためここに置く。
import { Effect, FileSystem, Schema } from "effect";
import { formatIssues, oneLine } from "./truthFile.ts";

export class BrokenLogLine extends Schema.TaggedError<BrokenLogLine>()("BrokenLogLine", {
  line: Schema.Number,
  reason: Schema.String,
}) {}

const decodeLine = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

// 行番号は空行を除く前に採る（人がログを開いたときの行と合わせる）。読めない行は BrokenLogLine、ファイルが読めなければ PlatformError
export const readLogLines = Effect.fn("readLogLines")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(path);
  const lines = text
    .split("\n")
    .map((line, i) => ({ text: line, no: i + 1 }))
    .filter((line) => line.text.trim() !== "");
  const events: unknown[] = [];
  for (const line of lines) {
    events.push(
      yield* decodeLine(line.text).pipe(
        Effect.mapError((e) => new BrokenLogLine({ line: line.no, reason: oneLine(formatIssues(e.issue).issues.map(({ message }) => message).join(" / ")) })),
      ),
    );
  }
  return { lines, events };
});
