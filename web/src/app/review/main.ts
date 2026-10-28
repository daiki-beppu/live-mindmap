import { Menu, Popover, Slider, Tooltip } from "@foldkit/ui";
import { Option, Schema } from "effect";
import { Command, Update } from "foldkit";
import type { Html, HtmlBuilder } from "foldkit/html";
import { modifyFields } from "foldkit/struct";
import type { Snapshot } from "../../../../server/src/core/index.ts";
import { AUDIO_RATE, initialPlayback, PlaybackState, playbackReducer, type PlaybackEvent } from "../../reviewPlayback.ts";
import { reviewKeyEvent, type ReviewKeyAction } from "../../reviewKeys.ts";
import { displayBubbles, settledCaptions } from "../../captions.ts";
import { captionBubblesAt, snapshotAt, topicNameOf } from "../../reviewTimeline.ts";
import { initKeyList, keyListFolds, keyListView } from "../keys/keyList.ts";
import type { KeyId } from "../keys/table.ts";
import * as MapSurface from "../mapSurface/main.ts";
import type { Message as MapSurfaceMessage } from "../mapSurface/message.ts";
import { plainKey, surfaceFolds, type KeyHandler } from "../mapSurface/parentFolds.ts";
import { startingSurface, WIDE, type Flags } from "../startFlags.ts";
import * as SessionLayout from "../sessionLayout/main.ts";
import * as SidePanel from "../sidePanel/main.ts";
import { PauseAudio, PlayAudio, ReleaseFocus, ReleaseFocusAfterMenuClose, REVIEW_AUDIO_ID, SeekAudio, WriteAudioSettings } from "./command.ts";
import { reviewScreenOf, type Context } from "./context.ts";
import { controlsView, RATE_MENU_ID, RateMenu, SEEK_SLIDER_ID, tooltipId, VOLUME_SLIDER_ID } from "./controls.ts";
import { Message, type TooltipKey } from "./message.ts";
import { ObserveAudio } from "./mount.ts";

export const Model = Schema.Struct({
  playback: PlaybackState,
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
  seekSlider: Slider.Model,
  volumeSlider: Slider.Model,
  rateMenu: Menu.Model,
  keyList: Popover.Model,
  tooltips: Schema.Struct({
    prev: Tooltip.Model,
    toggle: Tooltip.Model,
    next: Tooltip.Model,
    mute: Tooltip.Model,
    captions: Tooltip.Model,
    rate: Tooltip.Model,
    side: Tooltip.Model,
  }),
  maybeSeekPointer: Schema.Option(Schema.Finite),
  isPressingSlider: Schema.Boolean,
  captionsHidden: Schema.Boolean,
  sessionLayout: Schema.Struct({
    intake: SessionLayout.Model.fields.intake,
    intakeToast: SessionLayout.Model.fields.intakeToast,
    screenToast: SessionLayout.Model.fields.screenToast,
    tapToast: SessionLayout.Model.fields.tapToast,
    viewingToast: SessionLayout.Model.fields.viewingToast,
    diffUpdate: SessionLayout.Model.fields.diffUpdate,
    local: SessionLayout.Model.fields.local,
  }),
});
export type Model = typeof Model.Type;

const SEEK_STEP_SECONDS = 1;
const VOLUME_STEP = 0.05;

const seekSliderInit = (context: Context): Slider.Model => Slider.init({ id: SEEK_SLIDER_ID, min: 0, max: context.playback.duration, step: SEEK_STEP_SECONDS });
const volumeSliderInit = (): Slider.Model => Slider.init({ id: VOLUME_SLIDER_ID, min: 0, max: 1, step: VOLUME_STEP });

export const init = (context: Context, flags: Flags = WIDE): Model => {
  const { mode: _mode, snapshot: _snapshot, speakerNames: _speakerNames, ...surface } = MapSurface.init(snapshotAt(context.timeline, context.playback.duration), "review", context.isMac);
  const mapSurface = startingSurface(surface, flags);
  const tooltip = (key: keyof Model["tooltips"]) => Tooltip.init({ id: tooltipId(key), showDelay: 0 });
  const { captions: _captions, captionsHidden: _captionsHidden, ...sessionLayout } = SessionLayout.init();
  return {
    playback: initialPlayback(context.playback.duration, Option.isSome(context.maybeAudioUrl) ? AUDIO_RATE : undefined),
    mapSurface,
    seekSlider: seekSliderInit(context),
    volumeSlider: volumeSliderInit(),
    rateMenu: Menu.init({ id: RATE_MENU_ID }),
    keyList: initKeyList(),
    tooltips: { prev: tooltip("prev"), toggle: tooltip("toggle"), next: tooltip("next"), mute: tooltip("mute"), captions: tooltip("captions"), rate: tooltip("rate"), side: tooltip("side") },
    maybeSeekPointer: Option.none(),
    isPressingSlider: false,
    captionsHidden: flags.startsNarrow,
    sessionLayout,
  };
};

export const snapshotOf = (context: Context, model: Model): Snapshot => snapshotAt(context.timeline, model.playback.time);

export const surfaceOf = (context: Context, model: Model): MapSurface.Model => ({ mode: "review", snapshot: snapshotOf(context, model), speakerNames: context.timeline.speakerNames, ...model.mapSurface });

const layoutOf = (context: Context, model: Model): SessionLayout.Model => ({
  ...model.sessionLayout,
  captions: { _tag: "Bubbles", bubbles: displayBubbles(settledCaptions(captionBubblesAt(context.timeline, model.playback.time)), model.playback.time, context.timeline.speakerNames).map((b) => ({ ...b, label: Option.none() })) },
  captionsHidden: model.captionsHidden,
  selfPaused: false,
  nameEdit: Option.none(),
});

type Return = Update.Return<Model, Message>;

export const makeUpdate = (context: Context) => {
  const storeSurface = (model: Model, surface: MapSurface.Model): Model => {
    const { mode: _mode, snapshot: _snapshot, speakerNames: _speakerNames, ...next } = surface;
    return modifyFields(model, { mapSurface: () => next });
  };
  const { foldMapSurface, foldEscapeKey, toggleSide: toggledSide, keyHandlers: surfaceKeyHandlers } = surfaceFolds<Model, Message>({
    read: (model) => Option.some(surfaceOf(context, model)),
    write: (model, surface) => storeSurface(model, surface),
    toParentMessage: (message) => Message.GotMapSurfaceMessage({ message }),
  });
  const { foldSessionLayout, foldViewingMode } = SessionLayout.sessionLayoutFolds<Model, Message>({
    read: (model) => Option.some(layoutOf(context, model)),
    write: (model, layout) => {
      const { captions: _captions, captionsHidden: _captionsHidden, ...sessionLayout } = layout;
      return modifyFields(model, { sessionLayout: () => sessionLayout });
    },
    toParentMessage: (message) => Message.GotSessionLayoutMessage({ message }),
  });
  const foldSeekSlider = Update.foldChild({
    update: Slider.update,
    read: (model: Model) => Option.some(model.seekSlider),
    write: (model: Model, seekSlider: Slider.Model) => modifyFields(model, { seekSlider: () => seekSlider }),
    toParentMessage: (message: Slider.Message) => Message.GotSeekSliderMessage({ message }),
    foldOutMessage: (outMessage: Slider.OutMessage) =>
      Slider.OutMessage.match(outMessage, { ChangedValue: ({ value }) => (model: Model) => byHuman(moved(model, { type: "seek", time: value })) }),
  });
  const foldVolumeSlider = Update.foldChild({
    update: Slider.update,
    read: (model: Model) => Option.some(model.volumeSlider),
    write: (model: Model, volumeSlider: Slider.Model) => modifyFields(model, { volumeSlider: () => volumeSlider }),
    toParentMessage: (message: Slider.Message) => Message.GotVolumeSliderMessage({ message }),
    foldOutMessage: (outMessage: Slider.OutMessage) =>
      Slider.OutMessage.match(outMessage, { ChangedValue: ({ value }) => (model: Model) => changedSettings(model, { type: "setVolume", volume: value }) }),
  });
  const foldRateMenu = Update.foldChild({
    update: RateMenu.update,
    read: (model: Model) => Option.some(model.rateMenu),
    write: (model: Model, rateMenu: Menu.Model) => modifyFields(model, { rateMenu: () => rateMenu }),
    toParentMessage: (message: Menu.Message) => Message.GotRateMenuMessage({ message }),
    foldOutMessage: (outMessage: Menu.OutMessage<string>) =>
      Menu.OutMessage.match(outMessage, {
        Selected: ({ index }) => (model: Model) => {
          const rate = context.playback.rates[index];
          return rate === undefined ? { model } : changedSettings(model, { type: "setRate", rate }, [ReleaseFocusAfterMenuClose()]);
        },
      }),
  });
  const foldTooltip = Update.foldChildAt({
    update: Tooltip.update,
    readAt: (model: Model, key: TooltipKey) => Option.some(model.tooltips[key]),
    writeAt: (model: Model, key: TooltipKey, tooltip: Tooltip.Model) => modifyFields(model, { tooltips: (tooltips) => ({ ...tooltips, [key]: tooltip }) }),
    toParentMessage: (key: TooltipKey, message: Tooltip.Message) => Message.GotTooltipMessage({ tooltipId: key, message }),
    foldOutMessage: () => () => (model: Model) => ({ model }),
  });
  const { foldKeyList, foldKeyListOpen, foldKeyListClose } = keyListFolds<Model, Message>({
    read: (model) => Option.some(model.keyList),
    write: (model, keyList) => modifyFields(model, { keyList: () => keyList }),
    toParentMessage: (message) => Message.GotKeyListMessage({ message }),
  });
  const foldRateMenuClose = Update.foldChildStep({
    update: RateMenu.close,
    read: (model: Model) => Option.some(model.rateMenu),
    write: (model: Model, rateMenu: Menu.Model) => modifyFields(model, { rateMenu: () => rateMenu }),
    toParentMessage: (message: Menu.Message) => Message.GotRateMenuMessage({ message }),
    foldOutMessage: () => (model: Model) => ({ model }),
  });
  const reduce = (model: Model, event: PlaybackEvent): Model => {
    const playback = playbackReducer(model.playback, event, context.playback);
    const replaced = modifyFields(model, { playback: () => playback });
    const before = snapshotAt(context.timeline, model.playback.time);
    const after = snapshotAt(context.timeline, playback.time);
    if (before === after || Option.isNone(model.mapSurface.size)) return replaced;
    return storeSurface(replaced, MapSurface.changedSnapshot(surfaceOf(context, model), after));
  };
  const hasAudio = Option.isSome(context.maybeAudioUrl);
  const moved = (model: Model, event: PlaybackEvent): Return => {
    const next = reduce(model, event);
    if (hasAudio && next.playback.time !== model.playback.time) return { model: next, commands: [SeekAudio({ time: next.playback.time })] };
    return { model: next };
  };
  const toggled = (model: Model): Return => {
    const next = reduce(model, { type: "toggle" });
    if (!hasAudio) return { model: next };
    if (!next.playback.playing) return { model: next, commands: [PauseAudio()] };
    const { rate, muted, volume } = next.playback;
    const play = [WriteAudioSettings({ rate, muted, volume }), PlayAudio()];
    if (next.playback.time !== model.playback.time) return { model: next, commands: [SeekAudio({ time: next.playback.time }), ...play] };
    return { model: next, commands: play };
  };
  const heardTime = (model: Model, time: number): Return => {
    const next = reduce(model, { type: "audioTime", time });
    if (model.playback.playing && !next.playback.playing) return { model: next, commands: [PauseAudio()] };
    return { model: next };
  };
  const failedPlay = (model: Model, isAborted: boolean): Return =>
    !isAborted && model.playback.playing ? { model: reduce(model, { type: "toggle" }) } : { model };
  const changedSettings = (model: Model, event: PlaybackEvent, extra: ReadonlyArray<ReturnType<typeof ReleaseFocus> | ReturnType<typeof ReleaseFocusAfterMenuClose>> = []): Return => {
    const next = reduce(model, event);
    const { rate, muted, volume } = next.playback;
    const commands = [...(hasAudio ? [WriteAudioSettings({ rate, muted, volume })] : []), ...extra];
    return commands.length === 0 ? { model: next } : { model: next, commands };
  };
  const toggledKeyList = (result: Return): Return => ({ ...result, model: storeSurface(result.model, MapSurface.toggledKeyList(surfaceOf(context, result.model))) });
  const released = (model: Model): Return => ({ model, commands: [ReleaseFocus()] });
  const byHuman = (result: Return): Return => ({ ...result, model: storeSurface(result.model, MapSurface.movedTime(surfaceOf(context, result.model))) });
  const toggledCaptions = (model: Model): Model => modifyFields(model, { captionsHidden: (hidden) => !hidden });

  const escapeKey: KeyHandler<Model, Message> = (model, modifiers) =>
    model.rateMenu.isOpen
      ? foldRateMenuClose(model)
      : model.keyList.isOpen
        ? toggledKeyList(foldKeyListClose(model))
        : foldEscapeKey(model, modifiers);
  const reviewKey = (action: ReviewKeyAction): KeyHandler<Model, Message> => (model, { metaKey, ctrlKey, altKey }) => {
    const keyEvent = reviewKeyEvent(action, { meta: metaKey, ctrl: ctrlKey, alt: altKey }, model.playback.time, context.playback.duration);
    if (keyEvent === null) return { model };
    if (!keyEvent.movesTime) return changedSettings(model, keyEvent.event);
    return byHuman(keyEvent.event.type === "toggle" ? toggled(model) : moved(model, keyEvent.event));
  };
  const KEY_HANDLERS: Record<KeyId, KeyHandler<Model, Message>> = {
    ...surfaceKeyHandlers,
    Escape: escapeKey,
    C: plainKey((model) => ({ model: toggledCaptions(model) })),
    "?": plainKey((model) => toggledKeyList(model.keyList.isOpen ? foldKeyListClose(model) : foldKeyListOpen(model))),
    Space: reviewKey("toggle"),
    K: reviewKey("toggle"),
    J: reviewKey("back"),
    L: reviewKey("forward"),
    ",": reviewKey("prev"),
    ".": reviewKey("next"),
    "<": reviewKey("slower"),
    ">": reviewKey("faster"),
    Home: reviewKey("start"),
    End: reviewKey("end"),
    M: reviewKey("mute"),
  };
  const updateOwn = (model: Model, message: Message): Return =>
    Message.match<Return>(message, {
      ClickedPrev: () => byHuman(moved(model, { type: "prev" })),
      ClickedNext: () => byHuman(moved(model, { type: "next" })),
      ClickedToggle: () => byHuman(toggled(model)),
      TickedFrame: ({ ms }) => ({ model: reduce(model, { type: "elapsed", seconds: ms / 1000 }) }),
      UpdatedAudioTime: ({ time }) => heardTime(model, time),
      EndedAudio: () => ({ model: reduce(model, { type: "ended" }) }),
      FailedPlayAudio: ({ isAborted }) => failedPlay(model, isAborted),
      SucceededPlayAudio: () => ({ model }),
      CompletedPauseAudio: () => ({ model }),
      CompletedSeekAudio: () => ({ model }),
      CompletedWriteAudioSettings: () => ({ model }),
      GotMapSurfaceMessage: ({ message }) => foldMapSurface(model, message),
      GotSessionLayoutMessage: ({ message }) => foldSessionLayout(model, message),
      GotSeekSliderMessage: ({ message }) => foldSeekSlider(model, message),
      GotVolumeSliderMessage: ({ message }) => foldVolumeSlider(model, message),
      GotRateMenuMessage: ({ message }) => foldRateMenu(model, message),
      GotKeyListMessage: ({ message }) => foldKeyList(model, message),
      PressedKey: ({ key, metaKey, ctrlKey, altKey }) => KEY_HANDLERS[key](model, { metaKey, ctrlKey, altKey }),
      GotTooltipMessage: ({ tooltipId, message }) => foldTooltip(model, tooltipId, message),
      ClickedMute: () => changedSettings(model, { type: "toggleMute" }, [ReleaseFocus()]),
      ToggledCaptions: ({ isOpen }) => released(modifyFields(model, { captionsHidden: () => !isOpen })),
      ClickedSide: () => Update.combine(model, [toggledSide, released]),
      MovedSeekPointer: ({ fraction }) => ({ model: modifyFields(model, { maybeSeekPointer: () => Option.some(fraction) }) }),
      LeftSeekPointer: () => ({ model: modifyFields(model, { maybeSeekPointer: () => Option.none() }) }),
      PressedSliderPointer: () => ({ model: modifyFields(model, { isPressingSlider: () => true }) }),
      ReleasedSliderPointer: () => (model.isPressingSlider ? released(modifyFields(model, { isPressingSlider: () => false })) : { model }),
      CancelledSliderPointer: () =>
        model.isPressingSlider
          ? {
              model: modifyFields(model, { isPressingSlider: () => false, seekSlider: () => seekSliderInit(context), volumeSlider: () => volumeSliderInit() }),
              commands: [ReleaseFocus()],
            }
          : { model },
      CompletedReleaseFocus: () => ({ model }),
      CompletedReleaseFocusAfterMenuClose: () => ({ model }),
    });
  const withBlinkRestart = (model: Model, result: Return): Return => {
    if (result.model.playback.time === model.playback.time) return result;
    const restarts = Command.mapMessages(MapSurface.blinkRestartsOf(surfaceOf(context, model), surfaceOf(context, result.model)), (message: MapSurfaceMessage) => Message.GotMapSurfaceMessage({ message }));
    return restarts.length === 0 ? result : { ...result, commands: [...(result.commands ?? []), ...restarts] };
  };
  return (model: Model, message: Message): Return => {
    const result = updateOwn(model, message);
    const { mode } = result.model.mapSurface.viewing;
    if (mode === model.mapSurface.viewing.mode) return withBlinkRestart(model, result);
    return withBlinkRestart(model, Update.combine(model, [() => result, (next: Model) => foldViewingMode(next, mode)]));
  };
};

export const makeView = (context: Context) => (model: Model, h: HtmlBuilder<Message>): Html => {
  const toMapSurface = (message: MapSurfaceMessage) => Message.GotMapSurfaceMessage({ message });
  const surface = surfaceOf(context, model);
  return h.div(
    [h.Class("review flex flex-col w-full h-full")],
    [
      h.div(
        [h.Class("review__session flex-1 min-h-0 relative")],
        [
          h.submodel({
            slotId: "session-layout",
            view: SessionLayout.submodelView,
            model: layoutOf(context, model),
            viewInputs: {
              map: () => h.submodel({ slotId: "map-surface", view: MapSurface.view, model: surface, toParentMessage: toMapSurface }),
              keyList: () => keyListView(h, model.keyList, reviewScreenOf(context), (message) => Message.GotKeyListMessage({ message })),
              side: () => h.submodel({ slotId: "side-panel", view: SidePanel.view, model: surface, toParentMessage: toMapSurface }),
            },
            toParentMessage: (message) => Message.GotSessionLayoutMessage({ message }),
          }),
        ],
      ),
      controlsView(context, model, topicNameOf(snapshotOf(context, model)), h),
      ...Option.match(context.maybeAudioUrl, {
        onNone: () => [],
        onSome: (url) => [h.audio([h.Id(REVIEW_AUDIO_ID), h.Src(url), h.Preload("auto"), h.OnMount(ObserveAudio())])],
      }),
    ],
  );
};
