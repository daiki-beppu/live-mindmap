import { NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { exitNaturally } from "../src/exitNaturally.ts";
import { benchProgram, readInputText, write } from "./entry.ts";
import { parseTimeline } from "./sttAccuracy.ts";
import type { ReplayItem } from "./sttReplay.ts";

const letters = (n: number): string => (n < 26 ? "" : letters(Math.floor(n / 26) - 1)) + String.fromCharCode(65 + (n % 26));

export function timelineReplay(text: string, self: string): ReplayItem[] {
  const labels = new Map<string, string>();
  return parseTimeline(text).map(({ speaker, start, end, text }, i) => {
    const base = { id: `r${i + 1}`, start, end, at: end, text };
    if (speaker === self) return { ...base, track: "自分" };
    const label = labels.get(speaker) ?? `相手 ${letters(labels.size)}`;
    labels.set(speaker, label);
    return { ...base, track: "相手", speaker: label };
  });
}

export const command = Command.make("timelineReplay", {
  timeline: Argument.String("timeline").pipe(Argument.withDescription("話者・開始秒・終了秒・文の四列の timeline.tsv")),
  self: Flag.String("self").pipe(Flag.withDescription("自分トラックにする台本の人")),
}, Effect.fn("timelineReplay")(function* ({ timeline, self }) {
  yield* write(JSON.stringify(timelineReplay(yield* readInputText(timeline), self), null, 2));
})).pipe(Command.withDescription("台本を正しい話者付きの sttReplay 入力へ変換する"));

if (import.meta.main) {
  benchProgram(command).pipe(
    NodeRuntime.runMain({ disableErrorReporting: true, teardown: exitNaturally }),
  );
}
