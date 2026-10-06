// ツールチェーンの確認用（#194）。Node の型を使わない core 側で Effect が型検査を通るか
import { Context, Effect, Layer, Schema } from "effect";

export const Remark = Schema.Struct({
  speaker: Schema.Literals(["self", "other"]),
  text: Schema.String,
});
export type Remark = typeof Remark.Type;

export class InvalidRemark extends Schema.TaggedError<InvalidRemark>()("InvalidRemark", {
  reason: Schema.String,
}) {}

export const decodeRemark = (input: unknown) =>
  Schema.decodeUnknownEffect(Remark)(input).pipe(
    Effect.mapError((e) => new InvalidRemark({ reason: String(e) })),
  );

export class Clock2 extends Context.Service<Clock2, { readonly now: () => number }>()("Clock2") {
  static readonly fixed = (t: number) => Layer.succeed(Clock2, { now: () => t });
}

export const stamp = Effect.fn("stamp")(function* (input: unknown) {
  const clock = yield* Clock2;
  const remark = yield* decodeRemark(input);
  return { ...remark, at: clock.now() };
});

// 型推論の確認: 成功・失敗・要件が期待どおりに出ること
type Check<T extends true> = T;
type Eq<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type S = ReturnType<typeof stamp>;
export type _ok = Check<Eq<Effect.Success<S>, Remark & { at: number }>>;
export type _err = Check<Eq<Effect.Error<S>, InvalidRemark>>;
export type _req = Check<Eq<Effect.Services<S>, Clock2>>;
