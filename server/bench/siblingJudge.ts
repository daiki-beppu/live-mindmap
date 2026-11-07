import { NodeRuntime } from "@effect/platform-node";
import { Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { exitNaturally } from "../src/exitNaturally.ts";
import { claudeJudge, type Judge } from "./claudeJudge.ts";
import { benchProgram } from "./entry.ts";
import { judgeSessions } from "./judgeSessions.ts";
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
  }, ({ paths, parent }) => judgeSessions(paths, {
    header: HEADER,
    output: OUTPUT,
    judge: (events) => judgeSiblings(events, judge, { parent: Option.getOrUndefined(parent) }),
    row: formatRow,
  })).pipe(Command.withDescription("最終マップの兄弟の意味を判定し、本文を残さず件数と「別でない」の割合を出す。最大のまとまりが 40 を超える回は合否も出す"));
}

if (import.meta.main) {
  benchProgram(createSiblingJudgeCommand(claudeJudge)).pipe(
    NodeRuntime.runMain({ disableErrorReporting: true, teardown: exitNaturally }),
  );
}
