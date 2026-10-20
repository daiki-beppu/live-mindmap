// 振り分け（DiffUpdater の口の 1 段）。差分更新を呼ぶたびに判定へ「新しい発言に決定・TODO が含まれるか」を聞き、
// 確からしさが ROUTE_THRESHOLD 以上（または判定できなかった回）なら Sonnet 5.5、未満なら Haiku 5.5 の差分更新を呼ぶ。
// query はモデルごとに 1 本。セッションの previousResponse は持ち主を区別しないので、ここで持ち主ごとに仕分ける。
import { Clock, Effect } from "effect";
import { DiffUpdater, type DiffInput, type PreviousResponse, type Remark, type ScreenChange } from "./core/index.ts";
import type { JudgeAsk, JudgeQuestion } from "./systemOne.ts";

export const SONNET = "claude-sonnet-5-5";
export const HAIKU = "claude-haiku-5-5";
// 「含む」の確からしさ（distribution.yes）がこの値以上なら Sonnet。比べる対象は yes の確率で、選んだ側の確からしさではない
const ROUTE_THRESHOLD = 0.3;
const CONTEXT_REMARKS = 6;
const UNSEEN_SCREENS_MAX = 3; // 使わない会話のために費用が膨らまないよう、未送画面の保持を制限する
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

export const routedUpdater = (parts: Parts) => Effect.sync(() => {
  let retained: readonly Remark[] = []; // 受け取った発言の、直前の発言の候補（DiffInput.recent は 3 件までなので自前で保つ）
  let last: Destination | undefined; // 前回の呼び出しで回した先。入力の previousResponse の持ち主
  const own: Record<Destination, PreviousResponse | undefined> = { [SONNET]: undefined, [HAIKU]: undefined };
  // 共有画面の変化は core が 1 度しか添えない。各 query が、自分がまだ受け取っていない変化を受け取れるように、query ごとに溜める
  const unseen: Record<Destination, readonly ScreenChange[]> = { [SONNET]: [], [HAIKU]: [] };

  const update = Effect.fnUntraced(function* (input: DiffInput) {
    // 呼ぶ前に確定させる（失敗・中断の後の回でも持ち主が正しく残る）
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

    const arrived = input.screens ?? [];
    const screens = [...unseen[destination], ...arrived];
    unseen[destination] = [];
    const other = destination === SONNET ? HAIKU : SONNET;
    unseen[other] = [...unseen[other], ...arrived].slice(-UNSEEN_SCREENS_MAX);
    // 開き直した query に送り直す画面は、この呼び出しで添える画面と重ならないものだけにする
    const starts = new Set(screens.map((c) => c.start));
    const previousScreens = (input.previousScreens ?? []).filter((c) => !starts.has(c.start));

    const { previousResponse: _dropped, screens: _screens, previousScreens: _previous, ...rest } = input;
    const handed = own[destination];
    const judge = outcome.ok
      ? { model: destination, ms, ...(likelihood !== undefined ? { confidence: likelihood } : {}) }
      : { model: destination, ms, failure: outcome.reason };
    const result = yield* (destination === HAIKU ? parts.haiku : parts.sonnet).update({
      ...rest,
      ...(screens.length ? { screens } : {}),
      ...(previousScreens.length ? { previousScreens } : {}),
      ...(handed ? { previousResponse: handed } : {}),
    }).pipe(Effect.mapError((error) => ({ _tag: error._tag, message: error.message, judge })));
    return { ...result, judge };
  });

  return DiffUpdater.of({ update, ...(parts.sonnet.katakana ? { katakana: parts.sonnet.katakana } : {}) });
});
