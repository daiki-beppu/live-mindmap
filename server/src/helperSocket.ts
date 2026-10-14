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

// つないだ接続。events は届いたメッセージ（テキスト）を届いた順に流す。ヘルパー側が閉じると（または接続が切れると）終わる。
// send はヘルパーへテキストを 1 件送る。開いていないときは何もしない（失敗は呼び出し側に返さない）
export type HelperSocket = { events: Stream.Stream<string>; send: (text: string) => Effect.Effect<void> };

// つないだら HelperSocket を返す。Scope を閉じると切断する
export const openHelperSocket = Effect.fnUntraced(function* (
  url: string,
): Effect.fn.Return<HelperSocket, HelperSocketError, Scope.Scope> {
  const queue = yield* Queue.make<string, Cause.Done>();
  const ws = yield* Effect.acquireRelease(
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
  const send = (text: string) =>
    Effect.sync(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(text, () => {});
    });
  return { events: Stream.fromQueue(queue), send };
});
