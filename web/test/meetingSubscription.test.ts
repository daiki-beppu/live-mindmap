import { Effect, Fiber, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindingsOf } from "../src/app/keys/table.ts";
import { Message as MapSurfaceMessage } from "../src/app/mapSurface/message.ts";
import { subscriptions } from "../src/app/meeting/subscription.ts";
import { element, eventOfBinding, fakeDocument, keydown, settle, type KeyInit } from "./keysHarness.ts";
import { FIRST, frameMessage, HEIGHTS, init, Message, SIZE, surfaceMessage, update, type MeetingMessage, type Model } from "./meetingHarness.ts";

// 会議中の Subscription のうち、キー（文書の keydown。Issue #829）。画面は会議中の表（"live"）で決まり、スナップショットが届くまで（表示面が無い間）は流れを空にする。
// 依存は選択の有無（Enter を開閉に使うかの判断に要る）。意味は update が決める（meeting.story.test.ts・meeting.scene.test.ts）。
// WebSocket・表示面の rAF・ポインタの Subscription は、実ブラウザの meeting.mount.heavy.test.ts が確かめる（見返しの 10 秒のタイマーは会議中に無い）

const NO_MODIFIERS = { metaKey: false, ctrlKey: false, altKey: false };
const pressed = (key: string) => Message.PressedKey({ key: key as never, ...NO_MODIFIERS });

const run = (messages: ReadonlyArray<MeetingMessage>): Model => messages.reduce((model, next) => update(model, next).model, init(false));
const measured = surfaceMessage(MapSurfaceMessage.MeasuredMapSurface({ ...SIZE, nodeHeights: HEIGHTS }));
const shown = (): Model => run([frameMessage(FIRST), measured]);
const selected = (): Model => run([frameMessage(FIRST), measured, surfaceMessage(MapSurfaceMessage.ClickedNodeButton({ nodeId: "A", clientX: 0, clientY: 0 }))]);

afterEach(() => vi.unstubAllGlobals());

// keys の stream は target を取らず、グローバルの document に付ける。偽の document に差し替えて走らせ、モデルから導いた依存で開く
const pressEachOn = (model: Model, inits: readonly KeyInit[]) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const doc = fakeDocument();
      vi.stubGlobal("document", doc);
      const collected: MeetingMessage[] = [];
      const stream = subscriptions.keys.dependenciesToStream(subscriptions.keys.modelToDependencies(model));
      const fiber = yield* Effect.forkChild(Stream.runForEach(stream, (m) => Effect.sync(() => void collected.push(m as MeetingMessage))));
      yield* settle;
      const perEvent: MeetingMessage[][] = [];
      for (const init of inits) {
        const before = collected.length;
        doc.fire(keydown(init));
        yield* settle;
        perEvent.push(collected.slice(before));
      }
      yield* Fiber.interrupt(fiber);
      return { perEvent, listenersAfter: doc.listenerCount("keydown") };
    }),
  );

describe("会議中の Subscription の keys", () => {
  it("スナップショットが届くまで（待ち表示の間）は、どのキーも Message にならない", async () => {
    const inits: KeyInit[] = [{ key: "f" }, { key: "e" }, { key: "?", shiftKey: true }, { key: "Escape" }];
    const { perEvent } = await pressEachOn(init(false), inits);
    expect(perEvent).toEqual([[], [], [], []]);
  });

  it("スナップショットが届いた後は、会議中の表のすべてのバインディングで PressedKey が 1 つだけ届く", async () => {
    const bindings = bindingsOf("live");
    const doc = await pressEachOn(
      shown(),
      bindings.map((b) => {
        const e = eventOfBinding(b.keys);
        return { key: e.key, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey };
      }),
    );
    bindings.forEach((b, i) => expect(doc.perEvent[i], b.keys).toEqual([pressed(b.key)]));
  });

  it("見返しのキー（Space・K・J・L・, . < > Home End M）は、スナップショットが届いた後でも Message にならない（会議中の表に無い）", async () => {
    const { perEvent } = await pressEachOn(shown(), [{ key: " " }, { key: "k" }, { key: "j" }, { key: "l" }, { key: "," }, { key: "." }, { key: "<", shiftKey: true }, { key: ">", shiftKey: true }, { key: "Home" }, { key: "End" }, { key: "m" }]);
    expect(perEvent.flat()).toEqual([]);
  });

  it("依存は選択の有無で変わる: ノードを選んだ時だけ、ノード本体のボタンの中の Enter が届く", async () => {
    expect(subscriptions.keys.modelToDependencies(selected())).not.toEqual(subscriptions.keys.modelToDependencies(shown()));
    const inCircle: KeyInit[] = [{ key: "Enter", target: element("button", ["map-node__button"]) }];
    expect((await pressEachOn(shown(), inCircle)).perEvent).toEqual([[]]);
    expect((await pressEachOn(selected(), inCircle)).perEvent).toEqual([[pressed("Enter")]]);
  });

  it("走り終えると、document の keydown の listener が残らない", async () => {
    expect((await pressEachOn(shown(), [{ key: "f" }])).listenersAfter).toBe(0);
  });
});
