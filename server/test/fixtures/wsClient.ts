import { Effect } from "effect";
import { WebSocket } from "ws";

export const connect = Effect.fnUntraced(function* (port: number, path: string, origin: string | undefined) {
  const ws = yield* Effect.acquireRelease(
    Effect.sync(() => new WebSocket(`ws://127.0.0.1:${port}${path}`, origin === undefined ? {} : { origin })),
    (s) => Effect.sync(() => s.terminate()),
  );
  const frames: unknown[] = [];
  const closed = new Promise<void>((resolve) => ws.once("close", resolve));
  ws.on("message", (data) => frames.push(JSON.parse(String(data))));
  let pings = 0;
  ws.on("ping", () => { pings += 1; });
  yield* Effect.tryPromise(() => new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  }));
  return {
    frames, closed, send: (data: string | Uint8Array) => ws.send(data), isOpen: () => ws.readyState === WebSocket.OPEN,
    pings: () => pings, close: () => ws.close(),
  };
});
