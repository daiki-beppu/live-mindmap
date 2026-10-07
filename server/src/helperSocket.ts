// ヘルパーへの WebSocket を開く。開いた直後に届いたメッセージを取りこぼさない。
// ws は、ハンドシェイクの応答と同じ塊で届いたフレームを、open の直後に process.nextTick で流す。
// open を待ってから message を購読すると、その間に流れたフレームが消える。
// そこで、前もって作った Queue へ、new WebSocket と同じ同期区間で message の登録を済ませ、届いたものを流し込む。
import { Cause, Effect, Queue, Schema, Stream, type Scope } from "effect";
import { WebSocket } from "ws";

// つなげなかった。呼び出し側（Helpers）が Schedule で再試行する
export class HelperSocketError extends Schema.TaggedError<HelperSocketError>()("HelperSocketError", {
  reason: Schema.String,
}) {
  override get message(): string {
    return `ヘルパーへ接続できません: ${this.reason}`;
  }
}

// つないだら、届いたメッセージ（テキスト）を届いた順に流す Stream を返す。Scope を閉じると切断する。
// ヘルパー側が閉じると（または接続が切れると）Stream が終わる
export const openHelperSocket = (url: string): Effect.Effect<Stream.Stream<string>, HelperSocketError, Scope.Scope> =>
  Effect.gen(function* () {
    const queue = yield* Queue.make<string, Cause.Done>();
    yield* Effect.acquireRelease(
      Effect.callback<WebSocket, HelperSocketError>((resume) => {
        const ws = new WebSocket(url);
        ws.on("message", (data) => Queue.offerUnsafe(queue, String(data)));
        let opened = false;
        ws.once("open", () => {
          opened = true;
          resume(Effect.succeed(ws));
        });
        // 開いた後の error は close が続くだけなので、Queue を終えて読む側へ伝える（未処理の error にしない）
        ws.on("error", (error) => {
          if (opened) Queue.endUnsafe(queue);
          else resume(Effect.fail(new HelperSocketError({ reason: error.message })));
        });
        ws.on("close", () => Queue.endUnsafe(queue));
        // つなぐ途中で中断されたら、つなぎかけの接続を捨てる
        return Effect.sync(() => ws.terminate());
      }),
      (ws) =>
        Effect.sync(() => {
          ws.terminate();
          Queue.endUnsafe(queue);
        }),
    );
    return Stream.fromQueue(queue);
  });
