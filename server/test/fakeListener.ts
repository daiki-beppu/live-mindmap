import { Context, Effect } from "effect";
import { HttpServer } from "effect/http";
import { NetAddress } from "effect/net";
import type { DiffUpdateFrame, SessionModeFrame, Snapshot, SpeakerNamesFrame } from "../src/core/index.ts";
import type { openListener } from "../src/http.ts";
import { Viewers, type ViewerFrame } from "../src/viewers.ts";

export type OpenListener = typeof openListener;

export function fakeListener(onPublish: (snapshot: Snapshot) => void = () => {}) {
  const ports: number[] = [];
  const published: Snapshot[] = [];
  const diffUpdates: DiffUpdateFrame[] = [];
  const modes: SessionModeFrame[] = [];
  const speakerNames: SpeakerNamesFrame[] = [];
  const events: Array<"drained" | "closed"> = [];
  const open = (port: number) =>
    Effect.gen(function* () {
      ports.push(port);
      yield* Effect.addFinalizer(() => Effect.sync(() => { events.push("closed"); }));
      const viewers = Viewers.of({
        forSession: Effect.gen(function* () {
          let sentMode = false;
          let sentDiff = false;
          yield* Effect.addFinalizer(() => Effect.sync(() => {
            if (sentDiff) diffUpdates.push({ type: "diff-update", state: null });
            if (sentMode) modes.push({ type: "session-mode", local: false });
          }));
          return (frame: ViewerFrame) => Effect.sync(() => {
            if (frame.type === "snapshot") {
              published.push(frame.snapshot);
              onPublish(frame.snapshot);
            } else if (frame.type === "diff-update") {
              sentDiff = true;
              diffUpdates.push(frame);
            } else if (frame.type === "session-mode") {
              sentMode = true;
              modes.push(frame);
            } else if (frame.type === "speaker-names") {
              speakerNames.push(frame);
            }
          });
        }),
        connect: () => Effect.void,
        drained: Effect.sync(() => { events.push("drained"); }),
      });
      const httpServer = HttpServer.make({
        serve: () => Effect.void,
        address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", port),
      });
      return Context.make(Viewers, viewers).pipe(Context.add(HttpServer.HttpServer, httpServer));
    });
  return { open: open satisfies OpenListener, ports, published, diffUpdates, modes, speakerNames, events };
}
