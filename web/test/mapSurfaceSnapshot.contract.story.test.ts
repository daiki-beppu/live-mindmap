import { Option } from "effect";
import type { Update } from "foldkit";
import { given, message, model as inspectModel, story } from "foldkit/story";
import { describe, expect, it } from "vitest";
import { Message as SurfaceMessage } from "../src/app/mapSurface/message.ts";
import * as Review from "../src/app/review/main.ts";
import { Message as ReviewMessage } from "../src/app/review/message.ts";
import { init as initMeeting, update as updateMeeting } from "../src/app/meeting/main.ts";
import { Message as MeetingMessage } from "../src/app/meeting/message.ts";
import { Message as FeedMessage } from "../src/app/liveFeed/message.ts";
import type { KeyId } from "../src/app/keys/table.ts";
import type { Stored } from "../src/app/mapSurface/main.ts";
import { shownText, type NoticeModel } from "../src/app/sessionLayout/toast.ts";
import { snapshotAt } from "../src/reviewTimeline.ts";
import { spokenFrame } from "./fixtures/captions.ts";
import { plainContext, settleNotice, stateAt } from "./reviewHarness.ts";

const MANUAL = "動かしています・議題が変わるか Esc で今の議題へ・? でキー一覧";
const OVERVIEW = "全体を見ています・F で変わったところへ・Esc で戻る・? でキー一覧";
const DIFF = "変わったところを見ています・Esc で戻る・? でキー一覧";

const observeViewing = <Model, Message>(config: {
  update: (model: Model, message: Message) => Update.Return<Model, Message>;
  initial: Model;
  key: (key: KeyId) => Message;
  surfaceMessage: (message: SurfaceMessage) => Message;
  surfaceOf: (model: Model) => typeof Stored.Type;
  toastOf: (model: Model) => NoticeModel;
}) => {
  let current = config.initial;
  const send = (input: Message) => story(
    config.update,
    given(current),
    message(input),
    settleNotice,
    inspectModel((next) => { current = next; }),
  );
  return {
    press: (key: KeyId) => send(config.key(key)),
    clickChange: (nodeId: string) => send(config.surfaceMessage(SurfaceMessage.ClickedChangeItem({ nodeId }))),
    notice: () => Option.getOrNull(shownText(config.toastOf(current))),
    selection: () => Option.getOrUndefined(config.surfaceOf(current).viewing.selection)?.id,
  };
};

const modifiers = { metaKey: false, ctrlKey: false, altKey: false };

const observe = <Model, Message>(update: (model: Model, message: Message) => Update.Return<Model, Message>, model: Model, changed: Message, unchanged: Message) => ({
  changed: () => (update(model, changed).commands ?? []).filter((c) => c.name === "RestartBlink"),
  unchanged: () => (update(model, unchanged).commands ?? []).filter((c) => c.name === "RestartBlink"),
});

const measuredMessage = SurfaceMessage.MeasuredMapSurface({ width: 800, height: 600, nodeHeights: {} });

describe.each([
  {
    screen: "会議の画面",
    prepareViewing: () => {
      const shown = updateMeeting(initMeeting(false), MeetingMessage.GotLiveFeedMessage({ message: FeedMessage.ReceivedLiveFrame({ frame: { type: "snapshot", snapshot: snapshotAt(plainContext.timeline, 100) }, receivedAt: 0 }) })).model;
      return observeViewing({
        update: updateMeeting,
        initial: updateMeeting(shown, MeetingMessage.GotMapSurfaceMessage({ message: measuredMessage })).model,
        key: (key) => MeetingMessage.PressedKey({ key, ...modifiers }),
        surfaceMessage: (message) => MeetingMessage.GotMapSurfaceMessage({ message }),
        surfaceOf: (model) => Option.getOrThrow(model.session).mapSurface,
        toastOf: (model) => Option.getOrThrow(model.session).sessionLayout.viewingToast,
      });
    },
    prepare: (measured: boolean) => {
      const frameMessage = (frame: Parameters<typeof FeedMessage.ReceivedLiveFrame>[0]["frame"]) => MeetingMessage.GotLiveFeedMessage({ message: FeedMessage.ReceivedLiveFrame({ frame, receivedAt: 0 }) });
      const shown = updateMeeting(initMeeting(false), frameMessage({ type: "snapshot", snapshot: snapshotAt(plainContext.timeline, 10) })).model;
      const model = updateMeeting(shown, MeetingMessage.GotMapSurfaceMessage({ message: measuredMessage })).model;
      const input = measured ? model : { ...model, session: Option.map(model.session, (session) => ({ ...session, mapSurface: { ...session.mapSurface, size: Option.none() } })) };
      return observe(updateMeeting, input, frameMessage({ type: "snapshot", snapshot: snapshotAt(plainContext.timeline, 100) }), frameMessage(spokenFrame("字幕です。", "相手")));
    },
  },
  {
    screen: "見返し",
    prepareViewing: () => {
      const update = Review.makeUpdate(plainContext);
      return observeViewing({
        update,
        initial: update(stateAt(plainContext, 100), ReviewMessage.GotMapSurfaceMessage({ message: measuredMessage })).model,
        key: (key) => ReviewMessage.PressedKey({ key, ...modifiers }),
        surfaceMessage: (message) => ReviewMessage.GotMapSurfaceMessage({ message }),
        surfaceOf: (model) => model.mapSurface,
        toastOf: (model) => model.sessionLayout.viewingToast,
      });
    },
    prepare: (measured: boolean) => {
      const update = Review.makeUpdate(plainContext);
      const shown = stateAt(plainContext, 10, { playing: true, rate: 1 });
      const model = update(shown, ReviewMessage.GotMapSurfaceMessage({ message: measuredMessage })).model;
      const input = measured ? model : { ...model, mapSurface: { ...model.mapSurface, size: Option.none() } };
      return observe(update, input, ReviewMessage.ClickedNext(), ReviewMessage.TickedFrame({ ms: 1000 }));
    },
  },
])("$screen: 点滅と見る mode の知らせの契約", ({ prepare, prepareViewing }) => {
  it("見る mode のキーで手動・全体・変わったところの知らせが入れ替わり、Esc で消える", () => {
    const screen = prepareViewing();
    expect(screen.notice()).toBeNull();
    screen.press("=");
    expect(screen.notice()).toBe(MANUAL);
    screen.press("F");
    expect(screen.notice()).toBe(OVERVIEW);
    screen.press("F");
    expect(screen.notice()).toBe(DIFF);
    screen.press("Escape");
    expect(screen.notice()).toBeNull();
  });

  it("mode が変わらないキーでは知らせを出さず、表示中の知らせも変えない", () => {
    const screen = prepareViewing();
    screen.press("Z");
    expect(screen.notice()).toBeNull();
    screen.press("E");
    expect(screen.notice()).toBeNull();
    screen.press("=");
    expect(screen.notice()).toBe(MANUAL);
    screen.press("-");
    expect(screen.notice()).toBe(MANUAL);
  });

  it("変わったことの項目クリックでノードを選ぶ同じ操作で手動の知らせを出す", () => {
    const screen = prepareViewing();
    expect(screen.notice()).toBeNull();
    screen.clickChange("n2");
    expect(screen.selection()).toBe("n2");
    expect(screen.notice()).toBe(MANUAL);
  });

  it("測定済みで反映番号が変わり、点滅対象があると RestartBlink を1つ返す", () => {
    expect(prepare(true).changed()).toHaveLength(1);
  });

  it("スナップショットを変えない Message では RestartBlink を返さない", () => {
    expect(prepare(true).unchanged()).toHaveLength(0);
  });

  it("測る前は反映番号が変わっても RestartBlink を返さない", () => {
    expect(prepare(false).changed()).toHaveLength(0);
  });
});
