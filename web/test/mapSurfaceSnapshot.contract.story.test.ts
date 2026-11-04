import { Option } from "effect";
import type { Update } from "foldkit";
import { describe, expect, it } from "vitest";
import { Message as SurfaceMessage } from "../src/app/mapSurface/message.ts";
import * as Review from "../src/app/review/main.ts";
import { Message as ReviewMessage } from "../src/app/review/message.ts";
import { init as initMeeting, update as updateMeeting } from "../src/app/meeting/main.ts";
import { Message as MeetingMessage } from "../src/app/meeting/message.ts";
import { Message as FeedMessage } from "../src/app/liveFeed/message.ts";
import { snapshotAt } from "../src/reviewTimeline.ts";
import { spokenFrame } from "./fixtures/captions.ts";
import { plainContext, stateAt } from "./reviewHarness.ts";

const observe = <Model, Message>(update: (model: Model, message: Message) => Update.Return<Model, Message>, model: Model, changed: Message, unchanged: Message) => ({
  changed: () => (update(model, changed).commands ?? []).filter((c) => c.name === "RestartBlink"),
  unchanged: () => (update(model, unchanged).commands ?? []).filter((c) => c.name === "RestartBlink"),
});

const measuredMessage = SurfaceMessage.MeasuredMapSurface({ width: 800, height: 600, nodeHeights: {} });

describe.each([
  {
    screen: "会議の画面",
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
    prepare: (measured: boolean) => {
      const update = Review.makeUpdate(plainContext);
      const shown = stateAt(plainContext, 10, { playing: true, rate: 1 });
      const model = update(shown, ReviewMessage.GotMapSurfaceMessage({ message: measuredMessage })).model;
      const input = measured ? model : { ...model, mapSurface: { ...model.mapSurface, size: Option.none() } };
      return observe(update, input, ReviewMessage.ClickedNext(), ReviewMessage.TickedFrame({ ms: 1000 }));
    },
  },
])("$screen: スナップショット更新の点滅の契約", ({ prepare }) => {
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
