import { basename, join } from "node:path";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { readLogLines } from "../src/sessionFiles.ts";
import { claudeJudge, type Judge } from "./claudeJudge.ts";
import { BENCH_VERSION, exitNaturally, InvalidInputFile, reportFailure, write } from "./entry.ts";
import { formatRow, HEADER, judgeSiblings } from "./siblingJudgement.ts";

const OUTPUT = "siblingJudge.json";

export function createSiblingJudgeCommand<E, R>(judge: Judge<E, R>) {
  return Command.make("siblingJudge", {
    paths: Argument.String("session").pipe(
      Argument.withDescription("セッションのフォルダ（log.jsonl があるフォルダ。合成会議・実会議の再生のどちらも可）"),
      Argument.atLeast(1),
    ),
    parent: Flag.String("parent").pipe(
      Flag.withDescription("直下の子を（5 未満でも）別に判定する親のノード id。ルートは指定できない"),
      Flag.optional,
    ),
  }, Effect.fnUntraced(function* ({ paths, parent }) {
    const fs = yield* FileSystem.FileSystem;
    yield* write(HEADER);
    for (const dir of paths) {
      const path = join(dir, "log.jsonl");
      const { events } = yield* readLogLines(path).pipe(
        Effect.mapError((error) => new InvalidInputFile({
          path, reason: error._tag === "BrokenLogLine" ? `行 ${error.line} のJSONが不正です` : "ログの読込に失敗しました",
        })),
      );
      const result = yield* judgeSiblings(events, judge, { parent: Option.getOrUndefined(parent) }).pipe(
        Effect.mapError((error) => new InvalidInputFile({ path, reason: error.message })),
      );
      const output = join(dir, OUTPUT);
      yield* fs.writeFileString(output, JSON.stringify(result)).pipe(
        Effect.mapError(() => new InvalidInputFile({ path: output, reason: "判定結果の保存に失敗しました" })),
      );
      yield* write(formatRow(basename(dir), result));
    }
  })).pipe(Command.withDescription("最終マップの兄弟の意味を判定し、本文を残さず件数と「別でない」の割合を出す。最大のまとまりが 40 を超える回は合否も出す"));
}

if (import.meta.main) {
  Command.run(createSiblingJudgeCommand(claudeJudge), { version: BENCH_VERSION }).pipe(
    Effect.tapCause(reportFailure),
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain({ disableErrorReporting: true, teardown: exitNaturally }),
  );
}
