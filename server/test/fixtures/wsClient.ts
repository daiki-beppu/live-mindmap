import { Effect } from "effect";
import { WebSocket } from "ws";

// http のテストが /ws・/ へ張る WebSocket クライアント。受け取ったフレームと close の完了を返し、スコープを閉じると接続を捨てる。
// send は、ブラウザから届くメッセージを解釈しないことを確かめるテストが使う。
// 軽い IT（http.it.test.ts・viewingPort.it.test.ts）と重い IT（http.heavy.test.ts）から使う。
export const connect = Effect.fnUntraced(function* (port: number, path: string, origin: string | undefined) {
  const ws = yield* Effect.acquireRelease(
    Effect.sync(() => new WebSocket(`ws://127.0.0.1:${port}${path}`, origin === undefined ? {} : { origin })),
    (s) => Effect.sync(() => s.terminate()),
  );
  const frames: unknown[] = [];
  const closed = new Promise<void>((resolve) => ws.once("close", resolve));
  ws.on("message", (data) => frames.push(JSON.parse(String(data))));
  yield* Effect.tryPromise(() => new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  }));
  return { frames, closed, send: (data: string | Uint8Array) => ws.send(data), isOpen: () => ws.readyState === WebSocket.OPEN };
});
