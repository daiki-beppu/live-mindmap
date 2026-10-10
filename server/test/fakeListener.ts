// play の配信（http.ts の openListener。Viewers と HttpServer の Context を返す）の偽物。待ち受けずに、受け取ったポート・公開したスナップショット・
// 渡し切り（drained）と待受けを閉じた順番を記録する。本物の WebSocket 越しに観測するテストは actualListener を使う
import { Context, Effect } from "effect";
import { HttpServer } from "effect/http";
import { NetAddress } from "effect/net";
import type { DiffUpdateFrame, SessionModeFrame, Snapshot } from "../src/core/index.ts";
import type { openListener } from "../src/http.ts";
import { Viewers } from "../src/viewers.ts";

export type OpenListener = typeof openListener;

export function fakeListener(onPublish: (snapshot: Snapshot) => void = () => {}) {
  const ports: number[] = [];
  const published: Snapshot[] = [];
  const diffUpdates: DiffUpdateFrame[] = [];
  const modes: SessionModeFrame[] = [];
  // 「drained」「closed」を起きた順に積む。渡し切ってから閉じることを順番で観測する
  const events: Array<"drained" | "closed"> = [];
  const open = (port: number) =>
    Effect.gen(function* () {
      ports.push(port);
      // 本物と同じく、いまの Scope を閉じると待受けが閉じる
      yield* Effect.addFinalizer(() => Effect.sync(() => { events.push("closed"); }));
      const viewers = Viewers.of({
        publish: (snapshot) => Effect.sync(() => {
          published.push(snapshot);
          onPublish(snapshot);
        }),
        speak: () => Effect.void,
        intake: () => Effect.void,
        diffUpdate: (frame) => Effect.sync(() => { diffUpdates.push(frame); }),
        screenNotice: () => Effect.void,
        sessionMode: (frame) => Effect.sync(() => { modes.push(frame); }),
        connect: () => Effect.void,
        drained: Effect.sync(() => { events.push("drained"); }),
      });
      const httpServer = HttpServer.make({
        serve: () => Effect.void,
        address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", port),
      });
      return Context.make(Viewers, viewers).pipe(Context.add(HttpServer.HttpServer, httpServer));
    });
  return { open: open satisfies OpenListener, ports, published, diffUpdates, modes, events };
}
