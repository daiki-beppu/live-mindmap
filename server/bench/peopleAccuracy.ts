import { basename, join } from "node:path";
import { NodeRuntime } from "@effect/platform-node";
import { Effect, FileSystem, Schema, Stream } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { matchTruth, TruthItem, type Recall } from "../src/core/evaluate.ts";
import { JsonExport } from "../src/core/export.ts";
import { escapeCell } from "../src/core/markdownTable.ts";
import { Remark } from "../src/core/remark.ts";
import { SpeakerNameLogEvent } from "../src/core/speakerNames.ts";
import { exitNaturally } from "../src/exitNaturally.ts";
import { fileReason } from "../src/truthFile.ts";
import { benchProgram, InvalidInputFile, readInputText, write } from "./entry.ts";
import { createSpeakerAssignment } from "./speakerAccuracy.ts";
import { parseTimeline } from "./sttAccuracy.ts";

const TodoTruth = TruthItem.from.pipe(Schema.decodeTo(Schema.Struct({
  ...TruthItem.to.fields,
  担当: Schema.optionalKey(Schema.String),
})));
const IdeaTruth = TruthItem.from.pipe(Schema.decodeTo(Schema.Struct({
  ...TruthItem.to.fields,
  出した人: Schema.String,
})));

export const PeopleTruth = Schema.Struct({
  決定: Schema.Array(TruthItem),
  TODO: Schema.Array(TodoTruth),
  案: Schema.optionalKey(Schema.Array(IdeaTruth)),
});
export type PeopleTruth = typeof PeopleTruth["Type"];

const timestamp = Schema.String.check(Schema.makeFilter((s) => Number.isFinite(Date.parse(s))));
const RemarkEvent = Schema.Struct({ type: Schema.Literal("remark"), remark: Remark, at: timestamp });
const NameEvent = Schema.Struct({ ...SpeakerNameLogEvent.fields, at: timestamp });
type PeopleEvent = typeof RemarkEvent["Type"] | typeof NameEvent["Type"];

const rate = (hit: number, total: number) => total === 0 ? Number.NaN : hit / total;
const peopleScore = (recall: Recall, correct: number, none: number) => ({
  recall, correct, none, rates: { correct: rate(correct, recall.hit), none: rate(none, recall.hit) },
});

function scoreNames(firstRemarks: ReadonlyMap<string, number>, names: ReadonlyMap<string, { name: string; first: number }>, personOf: ReadonlyMap<string, string | undefined>) {
  const correct = [...names].filter(([label, { name }]) => personOf.get(label) === name).length;
  const times = [...names].flatMap(([label, { first }]) => {
    const remark = firstRemarks.get(label);
    return remark === undefined ? [] : [(first - remark) / 1000];
  }).sort((a, b) => a - b);
  const middle = Math.floor(times.length / 2);
  const medianSeconds = times.length === 0 ? undefined
    : times.length % 2 === 0 ? (times[middle - 1]! + times[middle]!) / 2 : times[middle]!;
  return { labels: names.size, correct, wrong: names.size - correct, rate: rate(correct, names.size), medianSeconds };
}

export function createPeopleScorer({ self, timeline }: {
  self: string;
  timeline: readonly ReturnType<typeof parseTimeline>[number][];
}) {
  const assignment = createSpeakerAssignment({ self, timeline });
  const firstRemarks = new Map<string, number>();
  const names = new Map<string, { name: string; first: number }>();
  return {
    add(event: PeopleEvent): void {
      if (event.type === "remark") {
        assignment.add(event.remark);
        const label = event.remark.speaker;
        if (label !== undefined && !firstRemarks.has(label)) firstRemarks.set(label, Date.parse(event.at));
      } else if (event.source === "推定") {
        names.set(event.label, { name: event.name, first: names.get(event.label)?.first ?? Date.parse(event.at) });
      }
    },
    score({ exp, truth }: { exp: JsonExport; truth: PeopleTruth }) {
      const personOf = assignment.finish();
      return { ...scorePeople({ self, personOf, exp, truth }), names: scoreNames(firstRemarks, names, personOf) };
    },
  };
}

function scorePeople({ self, personOf, exp, truth }: {
  self: string;
  personOf: ReadonlyMap<string, string | undefined>;
  exp: JsonExport;
  truth: PeopleTruth;
}) {
  const person = (label: string | undefined) => label === "自分" ? self
    : label === undefined || label === "相手" ? undefined : personOf.get(label);
  const ideas = truth.案 ?? [];
  const ideaPairs = matchTruth(exp, "案", ideas);
  const ideaCorrect = ideaPairs.filter(({ truth, node }) => person(node.proposer) === truth.出した人).length;
  const ideaNone = ideaPairs.filter(({ node }) => person(node.proposer) === undefined).length;
  const todos = truth.TODO.filter((item) => item.担当 !== undefined);
  const todoPairs = matchTruth(exp, "TODO", todos);
  const todoCorrect = todoPairs.filter(({ truth, node }) => {
    if (truth.担当 === "なし") return node.assignee === undefined && node.assigneeSpeaker === undefined;
    return (node.assignee === undefined ? person(node.assigneeSpeaker) : node.assignee) === truth.担当;
  }).length;
  const todoNone = todoPairs.filter(({ truth, node }) =>
    truth.担当 !== "なし" && node.assignee === undefined && node.assigneeSpeaker === undefined
  ).length;
  return {
    ideas: peopleScore({ hit: ideaPairs.length, total: ideas.length }, ideaCorrect, ideaNone),
    todos: peopleScore({ hit: todoPairs.length, total: todos.length }, todoCorrect, todoNone),
  };
}

const readPeopleJson = <S extends Schema.Decoder<unknown>>(path: string, schema: S) =>
  readInputText(path).pipe(Effect.flatMap((text) =>
    Schema.decodeEffect(Schema.fromJsonString(schema))(text).pipe(
      Effect.mapError(() => new InvalidInputFile({ path, reason: "JSON の構文または形が不正です" })),
    )
  ));

const EventType = Schema.Struct({ type: Schema.String });
const readPeopleLog = Effect.fn("readPeopleLog")(function* (path: string, scorer: ReturnType<typeof createPeopleScorer>) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.stream(path).pipe(
    Stream.mapError((error) => new InvalidInputFile({ path, reason: fileReason(error) })),
    Stream.decodeText,
    Stream.splitLines,
    Stream.runFoldEffect(() => 0, Effect.fnUntraced(function* (lineNumber, line) {
      const nextLine = lineNumber + 1;
      if (!line.trim()) return nextLine;
      const invalid = () => new InvalidInputFile({ path, reason: `${nextLine} 行目のイベントが不正です` });
      const raw = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(line).pipe(Effect.mapError(invalid));
      const { type } = yield* Schema.decodeUnknownEffect(EventType)(raw).pipe(Effect.mapError(invalid));
      if (type === "remark") scorer.add(yield* Schema.decodeUnknownEffect(RemarkEvent)(raw).pipe(Effect.mapError(invalid)));
      else if (type === "speaker-name") scorer.add(yield* Schema.decodeUnknownEffect(NameEvent)(raw).pipe(Effect.mapError(invalid)));
      return nextLine;
    })),
  );
});

const columns = ["セッション", "案 再現", "出した人 合う", "出した人 人なし", "TODO 再現", "担当 合う", "担当 人なし", "誤った名前", "名前 付いたラベル", "名前 正しい", "名前まで"];
const tableRow = (cells: readonly string[]) => `| ${cells.map(escapeCell).join(" | ")} |`;
const percent = (value: number) => Number.isNaN(value) ? "n/a" : `${(value * 100).toFixed(1)}%`;
function formatRow(dir: string, { ideas, todos, names }: ReturnType<ReturnType<typeof createPeopleScorer>["score"]>): string {
  return tableRow([
    basename(dir), `${ideas.recall.hit}/${ideas.recall.total}`, percent(ideas.rates.correct), percent(ideas.rates.none),
    `${todos.recall.hit}/${todos.recall.total}`, percent(todos.rates.correct), percent(todos.rates.none),
    String(names.wrong), String(names.labels), percent(names.rate), names.medianSeconds === undefined ? "—" : names.medianSeconds.toFixed(1),
  ]);
}

export const command = Command.make("peopleAccuracy", {
  self: Flag.String("self").pipe(Flag.withDescription("自分トラックの台本の人")),
  timeline: Argument.String("timeline").pipe(Argument.withDescription("合成会議の timeline.tsv")),
  truth: Argument.String("truth").pipe(Argument.withDescription("案の出した人・TODO の担当を含む正解 JSON")),
  paths: Argument.String("session").pipe(Argument.withDescription("log.jsonl と export.json のあるフォルダ"), Argument.atLeast(1)),
}, Effect.fn("peopleAccuracy")(function* ({ self, timeline: path, truth: truthPath, paths }) {
  const timeline = parseTimeline(yield* readInputText(path));
  const truth = yield* readPeopleJson(truthPath, PeopleTruth);
  const rows = yield* Effect.forEach(paths, Effect.fnUntraced(function* (dir) {
    const exp = yield* readPeopleJson(join(dir, "export.json"), JsonExport);
    const scorer = createPeopleScorer({ self, timeline });
    yield* readPeopleLog(join(dir, "log.jsonl"), scorer);
    return formatRow(dir, scorer.score({ truth, exp }));
  }));
  yield* write([tableRow(columns), tableRow(columns.map(() => "---")), ...rows].join("\n"));
})).pipe(Command.withDescription("保存済みセッションの出した人・担当・推定名を、本文なしの Markdown 表で採点する"));

if (import.meta.main) {
  benchProgram(command).pipe(
    NodeRuntime.runMain({ disableErrorReporting: true, teardown: exitNaturally }),
  );
}
