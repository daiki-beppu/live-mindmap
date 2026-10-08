import { Effect, Layer } from "effect";
import { restoreSession, type DiffInput, type DiffOutput, type Op, type Remark } from "../../src/core/index.ts";
import { forbiddenUpdater, silentLog, type UpdateFailure } from "./sessionLayers.ts";

let seq = 0;
export const remark = (text: string, extra: Partial<Remark> = {}): Remark => {
  seq++;
  return { id: `r${seq}`, track: "相手", start: seq * 10, end: seq * 10 + 9, text, ...extra };
};

export type Step = Op[] | UpdateFailure;

// 台本どおりに差分操作を返す（UpdateFailure なら失敗する）偽物の差分更新。呼ばれた入力を記録する。
export function scripted(...script: Step[]) {
  const calls: DiffInput[] = [];
  const update = (input: DiffInput): Effect.Effect<DiffOutput, UpdateFailure> => {
    calls.push(input);
    const step = script[calls.length - 1] ?? [];
    return Array.isArray(step) ? Effect.succeed({ ops: step }) : Effect.fail(step as UpdateFailure);
  };
  return { calls, update };
}

// 復元したセッションを、偽物の差分更新・何も書かないログで開く
export const restore = (events: Iterable<unknown>) => restoreSession(events).pipe(Effect.provide(Layer.merge(forbiddenUpdater, silentLog)));
