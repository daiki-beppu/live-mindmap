import { Effect, Fiber, Option, Queue, Schema } from "effect";
import { Socket } from "effect/socket";
import { describe, expect, it } from "vitest";
import type { Snapshot } from "../../server/src/core/index.ts";
import { Viewers } from "../../server/src/viewers.ts";
import { init, update } from "../src/app/liveFeed/main.ts";
import { LiveFrame, Message } from "../src/app/liveFeed/message.ts";

// server の Viewers が /ws に書く文字列を、web の受信の Schema と update にそのまま通す。送る側と受ける側の形の約束をまとめて見る。

const snapshot: Snapshot = {
  nodes: [
    { id: "root", parent: null, kind: "会議", text: "定例", evidence: [] },
    { id: "n1", parent: "root", kind: "議題", text: "採用", evidence: ["r1"] },
  ],
  round: 2, changes: [], remarks: [], currentTopic: "n1",
};

const decodeFrame = Schema.decodeUnknownOption(Schema.fromJsonString(LiveFrame));

const publishedData = (publish: (viewers: typeof Viewers.Service) => Effect.Effect<void>) =>
  Effect.runPromise(Effect.gen(function* () {
    const viewers = yield* Viewers;
    const written = yield* Queue.make<string>();
    const write: Socket.Writer["write"] = (chunk) => Socket.isCloseEvent(chunk) ? Effect.void : Queue.offer(written, typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    const socket = Socket.Socket.of({
      [Socket.TypeId]: Socket.TypeId,
      reader: Effect.succeed({ pull: Effect.never, upgrade: Socket.SocketUpgradeError.unsupported }),
      writer: Effect.succeed({ write, writeAll: (chunks) => Effect.forEach(chunks, write, { discard: true }) }),
    });
    yield* publish(viewers);
    const connection = yield* Effect.forkChild(viewers.connect(socket));
    const data = yield* Queue.take(written);
    yield* Fiber.interrupt(connection);
    return data;
  }).pipe(Effect.provide(Viewers.layer)));

describe("/ws のスナップショットのフレーム", () => {
  it("server が送ったスナップショットは、web の受信を通ると同じ Snapshot として Model に入る", async () => {
    const data = await publishedData((viewers) => viewers.publish(snapshot));
    const frame = Option.getOrThrow(decodeFrame(data));
    expect(update(init(), Message.ReceivedLiveFrame({ frame, receivedAt: 0 })).model.snapshot).toEqual(Option.some(snapshot));
  });

  it("未知の type を持つフレームは decode で失敗する（スナップショットとして通らない）", () => {
    expect(decodeFrame(JSON.stringify({ ...snapshot, type: "unknown" }))).toEqual(Option.none());
  });
});
