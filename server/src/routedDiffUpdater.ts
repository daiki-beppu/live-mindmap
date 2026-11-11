import { Cause, Clock, Effect, Exit, Result, Schema } from "effect";
import { DiffUpdatePaused, DiffUpdater, type DiffInput, type PreviousResponse, type Remark, type ScreenChange } from "./core/index.ts";
import type { JudgeAsk, JudgeQuestion } from "./systemOne.ts";

export const SONNET = "claude-sonnet-5-5";
export const HAIKU = "claude-haiku-5-5";
const ROUTE_THRESHOLD = 0.3;
const CONTEXT_REMARKS = 6;
const UNSEEN_SCREENS_MAX = 3;
const QUESTION_NAME = "route";
const QUESTION: JudgeQuestion = {
  type: "noul",
  instructions: "会議の文字起こしで、「新しい発言」の中に、決まったこと（合意・結論）か、誰かがやること（TODO・依頼・期限）が含まれるか。直前の発言は文脈で、そこだけにあるものは数えない",
};

const judgeState = (context: readonly Remark[], fresh: readonly Remark[]) =>
  ["# 直前の発言（文脈）", context.map((r) => r.text).join("\n") || "（なし）", "# 新しい発言", fresh.map((r) => r.text).join("\n")].join("\n");

const dedupById = (remarks: readonly Remark[]) => {
  const seen = new Set<string>();
  return remarks.filter((r) => !seen.has(r.id) && seen.add(r.id));
};

type Destination = typeof SONNET | typeof HAIKU;
type Parts = { readonly ask: JudgeAsk; readonly sonnet: DiffUpdater["Service"]; readonly haiku: DiffUpdater["Service"] };

const routeScreens = (unseen: Readonly<Record<Destination, readonly ScreenChange[]>>, to: Destination, arrived: readonly ScreenChange[]) => {
  const other = to === SONNET ? HAIKU : SONNET;
  return {
    send: [...unseen[to], ...arrived],
    unseenAfter: { ...unseen, [to]: [], [other]: [...unseen[other], ...arrived].slice(-UNSEEN_SCREENS_MAX) },
  };
};

const coreRedeliversScreens = (exit: Exit.Exit<unknown, unknown>): boolean => {
  if (Exit.isSuccess(exit)) return false;
  const failure = Cause.findError(exit.cause);
  return Result.isSuccess(failure) && Schema.is(DiffUpdatePaused)(failure.success);
};

export const routedUpdater = (parts: Parts) => Effect.sync(() => {
  let retained: readonly Remark[] = [];
  let last: Destination | undefined;
  const own: Record<Destination, PreviousResponse | undefined> = { [SONNET]: undefined, [HAIKU]: undefined };
  let unseen: Readonly<Record<Destination, readonly ScreenChange[]>> = { [SONNET]: [], [HAIKU]: [] };

  const update = Effect.fnUntraced(function* (input: DiffInput) {
    if (last !== undefined) own[last] = input.previousResponse;
    const freshIds = new Set(input.fresh.map((r) => r.id));
    const history = dedupById([...retained, ...input.recent]).filter((r) => !freshIds.has(r.id));
    const state = judgeState(history.slice(-CONTEXT_REMARKS), input.fresh);
    retained = dedupById([...history, ...input.fresh]).slice(-CONTEXT_REMARKS);

    const startedAt = yield* Clock.currentTimeMillis;
    const outcome = yield* parts.ask(state, { [QUESTION_NAME]: QUESTION });
    const ms = (yield* Clock.currentTimeMillis) - startedAt;
    const likelihood = outcome.ok ? outcome.answers[QUESTION_NAME]?.distribution.yes : undefined;
    const destination: Destination = likelihood !== undefined && likelihood < ROUTE_THRESHOLD ? HAIKU : SONNET;
    last = destination;

    const { send: screens, unseenAfter } = routeScreens(unseen, destination, input.screens ?? []);
    const { previousResponse: _dropped, screens: _screens, ...rest } = input;
    const handed = own[destination];
    const judge = outcome.ok
      ? { model: destination, ms, ...(likelihood !== undefined ? { confidence: likelihood } : {}) }
      : { model: destination, ms, failure: outcome.reason };
    const selected = destination === HAIKU ? parts.haiku : parts.sonnet;
    const result = yield* selected.update({
      ...rest,
      ...(screens.length ? { screens } : {}),
      ...(handed ? { previousResponse: handed } : {}),
    }).pipe(
      Effect.onExit((exit) => Effect.sync(() => {
        if (!coreRedeliversScreens(exit)) unseen = unseenAfter;
      })),
      Effect.mapError((error) => Schema.is(DiffUpdatePaused)(error) ? error : { _tag: error._tag, message: error.message, judge }),
    );
    return { ...result, judge, ...(selected.supplement === undefined ? {} : { supplement: selected.supplement }) };
  });

  return DiffUpdater.of({ update, ...(parts.sonnet.katakana ? { katakana: parts.sonnet.katakana } : {}) });
});
