import { Popover } from "@foldkit/ui";
import { Option, Schema } from "effect";
import { Command, Update } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { modifyFields } from "foldkit/struct";
import type { Snapshot } from "../../../../server/src/core/index.ts";
import type { ArrowDir, ViewKey } from "../../viewing.ts";
import { initKeyList, keyListView } from "../keys/keyList.ts";
import type { KeyId } from "../keys/table.ts";
import * as LiveFeed from "../liveFeed/main.ts";
import type { Message as LiveFeedMessage } from "../liveFeed/message.ts";
import * as MapSurface from "../mapSurface/main.ts";
import type { Message as MapSurfaceMessage } from "../mapSurface/message.ts";
import * as SessionLayout from "../sessionLayout/main.ts";
import { Message as SessionLayoutMessage } from "../sessionLayout/message.ts";
import * as SidePanel from "../sidePanel/main.ts";
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
    beforeOverview: MapSurface.Model.fields.beforeOverview,
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
    local: SessionLayout.Model.fields.local,
  }),
  keyList: Popover.Model,
});

export const Model = Schema.Struct({ feed: LiveFeed.Model, isMac: Schema.Boolean, session: Schema.Option(Session) });
export type Model = typeof Model.Type;
type SessionModel = typeof Session.Type;
type Return = Update.Return<Model, Message>;
const sameOption = (a: Option.Option<string>, b: Option.Option<string>): boolean => (Option.isNone(a) ? Option.isNone(b) : Option.isSome(b) && a.value === b.value);

export const init = (isMac: boolean): Model => ({ feed: LiveFeed.init(), isMac, session: Option.none() });

const surfaceOf = (feed: LiveFeed.Model, session: SessionModel): Option.Option<MapSurface.Model> =>
  Option.map(feed.snapshot, (snapshot) => ({ mode: "live" as const, snapshot, ...session.mapSurface }));
const stripSurface = (surface: MapSurface.Model): SessionModel["mapSurface"] => {
  const { mode: _mode, snapshot: _snapshot, ...rest } = surface;
  return rest;
};
const layoutOf = (feed: LiveFeed.Model, session: SessionModel): SessionLayout.Model => ({ ...session.sessionLayout, speaking: feed.speaking });
const stripLayout = (layout: SessionLayout.Model): SessionModel["sessionLayout"] => {
  const { speaking: _speaking, ...rest } = layout;
  return rest;
};

const mapSurfaceFold = {
  read: (model: Model) => Option.flatMap(model.session, (s) => surfaceOf(model.feed, s)),
  write: (model: Model, surface: MapSurface.Model) => modifyFields(model, { session: Option.map((s: SessionModel) => ({ ...s, mapSurface: stripSurface(surface) })) }),
  toParentMessage: (message: MapSurfaceMessage) => Message.GotMapSurfaceMessage({ message }),
  foldOutMessage: () => (model: Model) => ({ model }),
};
const foldMapSurface = Update.foldChild({ update: MapSurface.update, ...mapSurfaceFold });
const foldViewKey = Update.foldChild({ update: MapSurface.pressViewKey, ...mapSurfaceFold });
const foldArrowKey = Update.foldChild({ update: MapSurface.pressArrowKey, ...mapSurfaceFold });
const foldEscapeKey = Update.foldChild({ update: MapSurface.pressEscapeKey, ...mapSurfaceFold });
const foldEnterKey = Update.foldChild({ update: MapSurface.pressEnterKey, ...mapSurfaceFold });
const foldSideKey = Update.foldChild({ update: MapSurface.pressSideKey, ...mapSurfaceFold });

const sessionLayoutFold = {
  read: (model: Model) => Option.map(model.session, (s) => layoutOf(model.feed, s)),
  write: (model: Model, layout: SessionLayout.Model) => modifyFields(model, { session: Option.map((s: SessionModel) => ({ ...s, sessionLayout: stripLayout(layout) })) }),
  toParentMessage: (message: SessionLayoutMessage) => Message.GotSessionLayoutMessage({ message }),
  foldOutMessage: () => (model: Model) => ({ model }),
};
const foldSessionLayout = Update.foldChild({ update: SessionLayout.update, ...sessionLayoutFold });
const foldViewingMode = Update.foldChild({ update: SessionLayout.changeViewingMode, ...sessionLayoutFold });
const foldIntake = Update.foldChild({ update: SessionLayout.receiveIntakeStatus, ...sessionLayoutFold });
const foldScreenNotice = Update.foldChild({ update: SessionLayout.receiveScreenNotice, ...sessionLayoutFold });
const foldTapNotice = Update.foldChild({ update: SessionLayout.receiveTapNotice, ...sessionLayoutFold });
const foldDiffUpdate = Update.foldChild({ update: SessionLayout.receiveDiffUpdate, ...sessionLayoutFold });
const foldSessionMode = Update.foldChild({ update: SessionLayout.receiveSessionMode, ...sessionLayoutFold });

const keyListFold = {
  read: (model: Model) => Option.map(model.session, (s) => s.keyList),
  write: (model: Model, keyList: Popover.Model) => modifyFields(model, { session: Option.map((s: SessionModel) => ({ ...s, keyList })) }),
  toParentMessage: (message: Popover.Message) => Message.GotKeyListMessage({ message }),
  foldOutMessage: () => (model: Model) => ({ model }),
};
const foldKeyList = Update.foldChild({ update: Popover.update, ...keyListFold });
const foldKeyListOpen = Update.foldChildStep({ update: Popover.open, ...keyListFold });
const foldKeyListClose = Update.foldChildStep({ update: Popover.close, ...keyListFold });

const received = (model: Model, feed: LiveFeed.Model): Return => {
  const before = model.feed;
  const withFeed = modifyFields(model, { feed: () => feed });
  if (Option.isNone(withFeed.session)) {
    if (Option.isNone(feed.snapshot)) return { model: withFeed };
    const surface = MapSurface.init(feed.snapshot.value, "live", model.isMac);
    const layout = SessionLayout.init();
    const session: SessionModel = { mapSurface: stripSurface(surface), sessionLayout: stripLayout(layout), keyList: initKeyList() };
    const created = modifyFields(withFeed, { session: () => Option.some(session) });
    return Update.combine(created, [
      (m: Model) => foldIntake(m, feed.intake),
      (m: Model) => foldScreenNotice(m, feed.screenNotice),
      (m: Model) => foldTapNotice(m, feed.tapNotice),
      (m: Model) => foldDiffUpdate(m, feed.diffUpdate),
      (m: Model) => foldSessionMode(m, feed.local),
    ]);
  }
  const steps: Array<(m: Model) => Return> = [];
  if (before.intake !== feed.intake) steps.push((m) => foldIntake(m, feed.intake));
  if (!sameOption(before.screenNotice, feed.screenNotice)) steps.push((m) => foldScreenNotice(m, feed.screenNotice));
  if (!sameOption(before.tapNotice, feed.tapNotice)) steps.push((m) => foldTapNotice(m, feed.tapNotice));
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
  model: modifyFields(model, { session: Option.map((s: SessionModel) => ({ ...s, mapSurface: stripSurface(MapSurface.changedSnapshot({ mode: "live", snapshot: previous, ...s.mapSurface }, snapshot)) })) }),
});

const viewingModeOf = (model: Model) => Option.map(model.session, (s) => s.mapSurface.viewing.mode);
const viewingNotices = (before: Model, result: Return): Return => {
  const was = viewingModeOf(before);
  const now = viewingModeOf(result.model);
  if (Option.isNone(now) || sameOption(was, now)) return result;
  return Update.combine(before, [() => result, (m: Model) => foldViewingMode(m, now.value)]);
};

type Modifiers = { metaKey: boolean; ctrlKey: boolean; altKey: boolean };
type KeyHandler = (model: Model, modifiers: Modifiers) => Return;
const NO_MODIFIERS: Modifiers = { metaKey: false, ctrlKey: false, altKey: false };
const plain = ({ metaKey, ctrlKey, altKey }: Modifiers) => !metaKey && !ctrlKey && !altKey;
const plainKey = (handler: (model: Model) => Return): KeyHandler => (model, modifiers) => (plain(modifiers) ? handler(model) : { model });
const viewKey = (key: ViewKey): KeyHandler => (model, modifiers) => foldViewKey(model, { key, ...modifiers });
const arrowKey = (dir: ArrowDir): KeyHandler => (model, modifiers) => foldArrowKey(model, { dir, ...modifiers });
const inert: KeyHandler = (model) => ({ model });
const keyListOpen = (model: Model) => Option.exists(model.session, (s) => s.keyList.isOpen);
const toggledKeyList = (result: Return): Return => ({ ...result, model: modifyFields(result.model, { session: Option.map((s: SessionModel) => ({ ...s, mapSurface: stripSurface(MapSurface.toggledKeyList({ mode: "live", snapshot: Option.getOrThrow(result.model.feed.snapshot), ...s.mapSurface })) })) }) });
const toggledCaptions = (model: Model): Model => modifyFields(model, { session: Option.map((s: SessionModel) => ({ ...s, sessionLayout: { ...s.sessionLayout, captionsHidden: !s.sessionLayout.captionsHidden } })) });

const KEY_HANDLERS: Record<KeyId, KeyHandler> = {
  Escape: (model, modifiers) => (keyListOpen(model) ? toggledKeyList(foldKeyListClose(model)) : foldEscapeKey(model, modifiers)),
  F: viewKey("F"), "=": viewKey("="), "-": viewKey("-"), "0": viewKey("0"), Z: viewKey("Z"),
  "Shift+ArrowLeft": viewKey("Shift+ArrowLeft"), "Shift+ArrowRight": viewKey("Shift+ArrowRight"), "Shift+ArrowUp": viewKey("Shift+ArrowUp"), "Shift+ArrowDown": viewKey("Shift+ArrowDown"),
  ArrowLeft: arrowKey("left"), ArrowRight: arrowKey("right"), ArrowUp: arrowKey("up"), ArrowDown: arrowKey("down"),
  Enter: foldEnterKey,
  E: plainKey((model) => foldSideKey(model, NO_MODIFIERS)),
  C: plainKey((model) => ({ model: toggledCaptions(model) })),
  "?": plainKey((model) => toggledKeyList(keyListOpen(model) ? foldKeyListClose(model) : foldKeyListOpen(model))),
  Space: inert, K: inert, J: inert, L: inert, ",": inert, ".": inert, "<": inert, ">": inert, Home: inert, End: inert, M: inert,
};

const updateOwn = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    GotLiveFeedMessage: ({ message: feedMessage }) => received(model, LiveFeed.update(model.feed, feedMessage as LiveFeedMessage).model),
    GotMapSurfaceMessage: ({ message: m }) => foldMapSurface(model, m),
    GotSessionLayoutMessage: ({ message: m }) => foldSessionLayout(model, m),
    GotKeyListMessage: ({ message: m }) => foldKeyList(model, m),
    PressedKey: ({ key, metaKey, ctrlKey, altKey }) => (Option.isNone(model.session) ? { model } : KEY_HANDLERS[key](model, { metaKey, ctrlKey, altKey })),
  });

export const update = (model: Model, message: Message): Return => viewingNotices(model, updateOwn(model, message));

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
  Option.match(model.session, {
    onNone: () => h.p([h.Class("waiting")], ["サーバーを待っています"]),
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
