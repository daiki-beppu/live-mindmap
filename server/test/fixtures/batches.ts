import { Effect, Layer } from "effect";
import { makeSession, restoreSession, type DiffInput, type DiffOutput, type LogEvent, type Op, type Remark, type Session } from "../../src/core/index.ts";
import { collectLog, updaterLayer, type UpdateFailure } from "./sessionLayers.ts";

// 差分更新は、呼び出し中でなければ発言 1 件ですぐ呼ぶ。複数の発言を 1 回の呼び出しにまとめて渡すのは、
// 呼び出し中に届いた発言だけ。このファイルは、その「呼び出し中に届かせる」流れをテストの側で作る。

// 次の組の呼び出しが始まるまで、スケジューラに順番を譲る。実時間の期限を超えたら、待った条件を示して落とす
const waitForCall = (calls: readonly DiffInput[], count: number) =>
  Effect.gen(function* () {
    const deadline = Date.now() + 5000;
    while (calls.length < count) {
      if (Date.now() > deadline) throw new Error(`差分更新の ${count} 回目の呼び出しが始まるのを待ったが、期限内に始まらなかった（呼び出し ${calls.length} 回）`);
      yield* Effect.yieldNow;
    }
  });

export type BatchStep = Op[] | UpdateFailure;

// 呼び出しを、テストの側が返すまで待たせる偽物の差分更新。呼ばれた入力を記録し、i 番目の呼び出しには台本の i 番目の手を返す。
export function gatedScripted(...script: BatchStep[]) {
  const calls: DiffInput[] = [];
  const replies: (() => void)[] = [];
  const update = (input: DiffInput): Effect.Effect<DiffOutput, UpdateFailure> =>
    Effect.callback<DiffOutput, UpdateFailure>((resume) => {
      const step = script[calls.length] ?? [{ op: "noop" as const, reason: "台本切れ" }];
      calls.push(input);
      replies.push(() => resume(Array.isArray(step) ? Effect.succeed({ ops: step }) : Effect.fail(step as UpdateFailure)));
    });
  return { calls, update, replies };
}

// held を、ログから戻した「まだ渡していない発言」として持つセッションを開く。復元は差分更新も log も呼ばない。held が空なら新しく開く
const openHolding = (title: string, held: readonly Remark[], events: LogEvent[]) => {
  if (held.length === 0) return makeSession({ title });
  const log: LogEvent[] = [{ type: "start", title }, ...held.map((remark): LogEvent => ({ type: "remark", remark }))];
  events.push(...log);
  return restoreSession(log);
};

// batches の各組を、それぞれ 1 回の差分更新の呼び出しに渡す。台本の i 番目の手が、i 番目の組の呼び出しの応答になる。
// 組 k の発言は、組 k-1 の呼び出し中に届け、その呼び出しが終わった時点でまとめて渡る。最初の組だけは、最後の 1 件より前の発言を
// 復元したたまりとして持たせたセッションで開き、最後の 1 件を push して 1 回目の呼び出しにまとめる（呼び出し中になる前の発言は 1 件ずつ呼ばれるため）。
// 組 k の反映が済んだ時点（次の組の呼び出しは始まっていて、まだ返事を待っている）で onApplied(k) を呼ぶ。反映の合間のスナップショットはここで読む。
// 返すときには、すべての呼び出しが終わっている。events には start と復元した発言の行も入れる。
export const playBatches = Effect.fn("playBatches")(function* (
  batches: readonly (readonly Remark[])[],
  script: readonly BatchStep[],
  options: {
    readonly events?: LogEvent[];
    readonly onApplied?: (k: number, session: Session) => Effect.Effect<void>;
  } = {},
) {
  const title = "定例";
  const events = options.events ?? [];
  const { calls, update, replies } = gatedScripted(...script);
  const layer = Layer.merge(updaterLayer(update), collectLog(events));
  const first = batches[0];
  if (!first || first.length === 0) throw new Error("最初の組には発言が要る");
  const session = yield* openHolding(title, first.slice(0, -1), events).pipe(Effect.provide(layer));
  yield* session.push(first.at(-1)!);
  for (const [k] of batches.entries()) {
    const following = batches[k + 1];
    if (following) for (const r of following) yield* session.push(r);
    replies[k]!();
    if (following) yield* waitForCall(calls, k + 2);
    else yield* session.idle;
    if (options.onApplied) yield* options.onApplied(k, session);
  }
  return { session, calls, events };
});
