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
  const events: Array<"drained" | "closed"> = [];
  const open = (port: number) =>
    Effect.gen(function* () {
      ports.push(port);
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
        tapNotice: () => Effect.void,
        selfPause: () => Effect.void,
        sessionMode: (frame) => Effect.sync(() => { modes.push(frame); }),
        speakerNames: () => Effect.void,
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
