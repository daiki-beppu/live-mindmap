import { Popover } from "@foldkit/ui";
import { Option, Schema } from "effect";
import { Command, Update } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { modifyFields } from "foldkit/struct";
import type { Snapshot } from "../../../../server/src/core/index.ts";
import { displayBubbles } from "../../captions.ts";
import { initKeyList, keyListFolds, keyListView } from "../keys/keyList.ts";
import type { KeyId } from "../keys/table.ts";
import * as LiveFeed from "../liveFeed/main.ts";
import type { Message as LiveFeedMessage } from "../liveFeed/message.ts";
import * as MapSurface from "../mapSurface/main.ts";
import type { Message as MapSurfaceMessage } from "../mapSurface/message.ts";
import { plainKey, surfaceFolds, type KeyHandler } from "../mapSurface/parentFolds.ts";
import { startingSurface, WIDE, type Flags } from "../startFlags.ts";
import * as SessionLayout from "../sessionLayout/main.ts";
import * as SidePanel from "../sidePanel/main.ts";
import { RequestSelfPause } from "./command.ts";
import { Message } from "./message.ts";

const Session = Schema.Struct({
  mapSurface: Schema.Struct({
    size: MapSurface.Model.fields.size,
    nodeHeights: MapSurface.Model.fields.nodeHeights,
    isMac: MapSurface.Model.fields.isMac,
    pointer: MapSurface.Model.fields.pointer,
    nodePress: MapSurface.Model.fields.nodePress,
    scrollAxisLock: MapSurface.Model.fields.scrollAxisLock,
    motion: MapSurface.Model.fields.motion,
    viewing: MapSurface.Model.fields.viewing,
    gestureScale: MapSurface.Model.fields.gestureScale,
    viewport: MapSurface.Model.fields.viewport,
    placedRound: MapSurface.Model.fields.placedRound,
    keepAnchor: MapSurface.Model.fields.keepAnchor,
    pendingShift: MapSurface.Model.fields.pendingShift,
    idleStamp: MapSurface.Model.fields.idleStamp,
  }),
  sessionLayout: Schema.Struct({
    captionsHidden: SessionLayout.Model.fields.captionsHidden,
    intake: SessionLayout.Model.fields.intake,
    intakeToast: SessionLayout.Model.fields.intakeToast,
    screenToast: SessionLayout.Model.fields.screenToast,
    tapToast: SessionLayout.Model.fields.tapToast,
    viewingToast: SessionLayout.Model.fields.viewingToast,
    diffUpdate: SessionLayout.Model.fields.diffUpdate,
    selfPaused: SessionLayout.Model.fields.selfPaused,
    local: SessionLayout.Model.fields.local,
    nameEdit: SessionLayout.Model.fields.nameEdit,
  }),
  keyList: Popover.Model,
});

// startsNarrow: 開いた時点で幅が狭かったか（startFlags.ts）。画面の部品はスナップショットが届いてから作るので、そのときに右の列と字幕を隠して始めるために覚えておく
export const Model = Schema.Struct({ feed: LiveFeed.Model, isMac: Schema.Boolean, startsNarrow: Schema.Boolean, session: Schema.Option(Session) });
export type Model = typeof Model.Type;
type SessionModel = typeof Session.Type;
type Return = Update.Return<Model, Message>;
const sameOption = (a: Option.Option<string>, b: Option.Option<string>): boolean => (Option.isNone(a) ? Option.isNone(b) : Option.isSome(b) && a.value === b.value);

export const init = (isMac: boolean, { startsNarrow }: Flags = WIDE): Model => ({ feed: LiveFeed.init(), isMac, startsNarrow, session: Option.none() });

const surfaceOf = (feed: LiveFeed.Model, session: SessionModel): Option.Option<MapSurface.Model> =>
  Option.map(feed.snapshot, (snapshot) => ({ mode: "live" as const, snapshot, speakerNames: feed.speakerNames, ...session.mapSurface }));
const stripSurface = (surface: MapSurface.Model): SessionModel["mapSurface"] => {
  const { mode: _mode, snapshot: _snapshot, speakerNames: _speakerNames, ...rest } = surface;
  return rest;
};
// 字幕は feed の吹き出しと名前の表から導く（保存しない。名前が付いたら、それまでの吹き出しも名前になる）。時刻は状態が最後に受けた時刻で、view は時刻を読まない
const layoutOf = (feed: LiveFeed.Model, session: SessionModel): SessionLayout.Model => ({ ...session.sessionLayout, captions: { _tag: "Bubbles", bubbles: displayBubbles(feed.captions, feed.captions.clock, feed.speakerNames) } });
const stripLayout = (layout: SessionLayout.Model): SessionModel["sessionLayout"] => {
  const { captions: _captions, ...rest } = layout;
  return rest;
};

const { foldMapSurface, foldEscapeKey, keyHandlers: surfaceKeyHandlers } = surfaceFolds<Model, Message>({
  read: (model) => Option.flatMap(model.session, (s) => surfaceOf(model.feed, s)),
  write: (model, surface) => modifyFields(model, { session: Option.map((s: SessionModel) => ({ ...s, mapSurface: stripSurface(surface) })) }),
  toParentMessage: (message) => Message.GotMapSurfaceMessage({ message }),
});

const { foldSessionLayout, foldViewingMode, foldIntake, foldScreenNotice, foldTapNotice, foldSelfPause, foldDiffUpdate, foldSessionMode } = SessionLayout.sessionLayoutFolds<Model, Message>({
  read: (model) => Option.map(model.session, (s) => layoutOf(model.feed, s)),
  write: (model, layout) => modifyFields(model, { session: Option.map((s: SessionModel) => ({ ...s, sessionLayout: stripLayout(layout) })) }),
  toParentMessage: (message) => Message.GotSessionLayoutMessage({ message }),
});

const { foldKeyList, foldKeyListOpen, foldKeyListClose } = keyListFolds<Model, Message>({
  read: (model) => Option.map(model.session, (s) => s.keyList),
  write: (model, keyList) => modifyFields(model, { session: Option.map((s: SessionModel) => ({ ...s, keyList })) }),
  toParentMessage: (message) => Message.GotKeyListMessage({ message }),
});

const received = (model: Model, feed: LiveFeed.Model): Return => {
  const before = model.feed;
  const withFeed = modifyFields(model, { feed: () => feed });
  if (Option.isNone(withFeed.session)) {
    if (Option.isNone(feed.snapshot)) return { model: withFeed };
    const surface = startingSurface(MapSurface.init(feed.snapshot.value, "live", model.isMac), { startsNarrow: model.startsNarrow });
    const layout = { ...SessionLayout.init(), captionsHidden: model.startsNarrow };
    const session: SessionModel = { mapSurface: stripSurface(surface), sessionLayout: stripLayout(layout), keyList: initKeyList() };
    const created = modifyFields(withFeed, { session: () => Option.some(session) });
    return Update.combine(created, [
      (m: Model) => foldIntake(m, feed.intake),
      (m: Model) => foldScreenNotice(m, feed.screenNotice),
      (m: Model) => foldTapNotice(m, feed.tapNotice),
      (m: Model) => foldSelfPause(m, feed.selfPaused),
      (m: Model) => foldDiffUpdate(m, feed.diffUpdate),
      (m: Model) => foldSessionMode(m, feed.local),
    ]);
  }
  const steps: Array<(m: Model) => Return> = [];
  if (before.intake !== feed.intake) steps.push((m) => foldIntake(m, feed.intake));
  if (!sameOption(before.screenNotice, feed.screenNotice)) steps.push((m) => foldScreenNotice(m, feed.screenNotice));
  if (!sameOption(before.tapNotice, feed.tapNotice)) steps.push((m) => foldTapNotice(m, feed.tapNotice));
  if (before.selfPaused !== feed.selfPaused) steps.push((m) => foldSelfPause(m, feed.selfPaused));
  if (before.diffUpdate !== feed.diffUpdate) steps.push((m) => foldDiffUpdate(m, feed.diffUpdate));
  if (before.local !== feed.local) steps.push((m) => foldSessionMode(m, feed.local));
  if (Option.isSome(before.snapshot) && Option.isSome(feed.snapshot) && before.snapshot.value !== feed.snapshot.value) {
    const next: Snapshot = feed.snapshot.value;
    steps.push((m) => {
      const oldSurface = Option.getOrThrow(Option.flatMap(model.session, (s) => surfaceOf(before, s)));
      const reflected = foldSnapshot(m, Option.getOrThrow(before.snapshot), next);
      const newSurface = Option.getOrThrow(Option.flatMap(reflected.model.session, (s) => surfaceOf(m.feed, s)));
      const restarts = Command.mapMessages(MapSurface.blinkRestartsOf(oldSurface, newSurface), (message: MapSurfaceMessage) => Message.GotMapSurfaceMessage({ message }));
      return restarts.length === 0 ? reflected : { ...reflected, commands: [...(reflected.commands ?? []), ...restarts] };
    });
  }
  return viewingNotices(model, Update.combine(withFeed, steps));
};

const foldSnapshot = (model: Model, previous: Snapshot, snapshot: Snapshot): Return => ({
  model: modifyFields(model, { session: Option.map((s: SessionModel) => ({ ...s, mapSurface: stripSurface(MapSurface.changedSnapshot({ mode: "live", snapshot: previous, speakerNames: {}, ...s.mapSurface }, snapshot)) })) }),
});

const viewingModeOf = (model: Model) => Option.map(model.session, (s) => s.mapSurface.viewing.mode);
const viewingNotices = (before: Model, result: Return): Return => {
  const was = viewingModeOf(before);
  const now = viewingModeOf(result.model);
  if (Option.isNone(now) || sameOption(was, now)) return result;
  return Update.combine(before, [() => result, (m: Model) => foldViewingMode(m, now.value)]);
};

const inert: KeyHandler<Model, Message> = (model) => ({ model });
const keyListOpen = (model: Model) => Option.exists(model.session, (s) => s.keyList.isOpen);
const toggledKeyList = (result: Return): Return => ({ ...result, model: modifyFields(result.model, { session: Option.map((s: SessionModel) => ({ ...s, mapSurface: stripSurface(MapSurface.toggledKeyList({ mode: "live", snapshot: Option.getOrThrow(result.model.feed.snapshot), speakerNames: {}, ...s.mapSurface })) })) }) });
const toggledCaptions = (model: Model): Model => modifyFields(model, { session: Option.map((s: SessionModel) => ({ ...s, sessionLayout: { ...s.sessionLayout, captionsHidden: !s.sessionLayout.captionsHidden } })) });

const KEY_HANDLERS: Record<KeyId, KeyHandler<Model, Message>> = {
  ...surfaceKeyHandlers,
  Escape: (model, modifiers) => (keyListOpen(model) ? toggledKeyList(foldKeyListClose(model)) : foldEscapeKey(model, modifiers)),
  C: plainKey((model) => ({ model: toggledCaptions(model) })),
  "?": plainKey((model) => toggledKeyList(keyListOpen(model) ? foldKeyListClose(model) : foldKeyListOpen(model))),
  Space: inert, K: inert, J: inert, L: inert, ",": inert, ".": inert, "<": inert, ">": inert, Home: inert, End: inert,
  // 画面に見えている状態（休止の一言が出ているか）の逆を、状態を指定する形で server へ送る。Model は変えない（切り替わるのは /ws の frame が届いたとき）
  M: plainKey((model) => ({ model, commands: [RequestSelfPause({ paused: !Option.exists(model.session, (s) => s.sessionLayout.selfPaused !== false) })] })),
};

const updateOwn = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    GotLiveFeedMessage: ({ message: feedMessage }) => received(model, LiveFeed.update(model.feed, feedMessage as LiveFeedMessage).model),
    GotMapSurfaceMessage: ({ message: m }) => foldMapSurface(model, m),
    GotSessionLayoutMessage: ({ message: m }) => foldSessionLayout(model, m),
    GotKeyListMessage: ({ message: m }) => foldKeyList(model, m),
    CompletedRequestSelfPause: () => ({ model }),
    PressedKey: ({ key, metaKey, ctrlKey, altKey }) => (Option.isNone(model.session) ? { model } : KEY_HANDLERS[key](model, { metaKey, ctrlKey, altKey })),
  });

export const update = (model: Model, message: Message): Return => viewingNotices(model, updateOwn(model, message));

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
  Option.match(model.session, {
    onNone: () => h.p([h.Class("waiting m-0 p-[2rem] text-gray-500")], ["サーバーを待っています"]),
    onSome: (session) => {
      const surface = Option.getOrThrow(surfaceOf(model.feed, session));
      return h.submodel({
        slotId: "session-layout",
        view: SessionLayout.submodelView,
        model: layoutOf(model.feed, session),
        viewInputs: {
          map: () => h.submodel({ slotId: "map-surface", view: MapSurface.view, model: surface, toParentMessage: (message: MapSurfaceMessage) => Message.GotMapSurfaceMessage({ message }) }),
          keyList: () => keyListView(h, session.keyList, "live", (message) => Message.GotKeyListMessage({ message })),
          side: () => h.submodel({ slotId: "side-panel", view: SidePanel.view, model: surface, toParentMessage: (message: MapSurfaceMessage) => Message.GotMapSurfaceMessage({ message }) }),
        },
        toParentMessage: (message) => Message.GotSessionLayoutMessage({ message }),
      });
    },
  });
