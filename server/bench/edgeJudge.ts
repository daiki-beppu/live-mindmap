import { NodeRuntime } from "@effect/platform-node";
import { Argument, Command } from "effect/cli";
import { exitNaturally } from "../src/exitNaturally.ts";
import { claudeJudge, type Judge } from "./claudeJudge.ts";
import { benchProgram } from "./entry.ts";
import { judgeSessions } from "./judgeSessions.ts";
import { formatRow, judgeEdges } from "./edgeJudgement.ts";

const OUTPUT = "edgeJudge.json";

export function createEdgeJudgeCommand<E, R>(judge: Judge<E, R>) {
  return Command.make("edgeJudge", {
    paths: Argument.String("session").pipe(
      Argument.withDescription("合成会議のセッションのフォルダ（log.jsonl があるフォルダ）"),
      Argument.atLeast(1),
    ),
  }, ({ paths }) => judgeSessions(paths, {
    header: "| セッション | 判定した辺 | 具体化 / 答え / 派生 / なし | なし |\n| --- | --- | --- | --- |",
    output: OUTPUT,
    judge: (events) => judgeEdges(events, judge),
    saved: (result) => result.edges,
    row: formatRow,
  })).pipe(Command.withDescription("合成会議の最終マップの辺の意味を判定し、本文を残さず件数と「なし」の割合を出す（実会議には使わない）"));
}

if (import.meta.main) {
  benchProgram(createEdgeJudgeCommand(claudeJudge)).pipe(
    NodeRuntime.runMain({ disableErrorReporting: true, teardown: exitNaturally }),
  );
}
