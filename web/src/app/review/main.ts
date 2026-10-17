// 見返しの Foldkit プログラム（Issue #822・#823・#825・#826）: Model・update・view の根。
// Model に持つのは再生の状態（PlaybackState）、表示面の実測（size・nodeHeights）、操作の行の状態（Slider・Menu・Tooltip の子の Model、ポインタの位置、押している最中か、字幕と右の列を隠しているか）。
// 時間軸・章・印と、その時刻のマップ（Snapshot）は導いた値なので Model の外に置く（時間軸・章・印は Context、Snapshot は playback.time から毎回導く）
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
  // 表示面の状態のうち、見返しが導く mode・snapshot を除いたもの（実測・カメラ・補間・見る状態）
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
  // キーの一覧（#822）。開いているかの正本はこの Popover の Model（見る状態の keyList は使わない）
  keyList: Popover.Model,
  // ボタンごとの Tooltip（欄名は TooltipKey）
  tooltips: Schema.Struct({
    prev: Tooltip.Model,
    toggle: Tooltip.Model,
    next: Tooltip.Model,
    mute: Tooltip.Model,
    captions: Tooltip.Model,
    rate: Tooltip.Model,
    side: Tooltip.Model,
  }),
  // シークバーの上のポインタの位置（左端 0・右端 1 の割合）。乗っていないときは None
  maybeSeekPointer: Schema.Option(Schema.Finite),
  // スライダー（シーク・音量）を押している最中か。離したらフォーカスを外すために、押した事実を覚える
  isPressingSlider: Schema.Boolean,
  // 字幕を隠しているか（字幕の部品へは view で渡す）。ボタンの押した状態（aria-pressed）とアイコンに使う。右の列の出し入れは表示面の見る状態（viewing.sideHidden）が持つ
  captionsHidden: Schema.Boolean,
  // セッションの画面の部品のうち、見返しが導かないもの（見る状態の知らせ。見返しは取り込み・共有画面の状態を送らない）。字幕と字幕を隠しているかは導く／別の欄が持つので除く
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

// シークバーは 1 秒刻み、音量は 0.05 刻み
const SEEK_STEP_SECONDS = 1;
const VOLUME_STEP = 0.05;

// シーク・音量のスライダーの設定。init と、中断で Idle に戻すときで同じものを使う
const seekSliderInit = (context: Context): Slider.Model => Slider.init({ id: SEEK_SLIDER_ID, min: 0, max: context.playback.duration, step: SEEK_STEP_SECONDS });
const volumeSliderInit = (): Slider.Model => Slider.init({ id: VOLUME_SLIDER_ID, min: 0, max: 1, step: VOLUME_STEP });

// 狭い幅で開いたら、右の列と字幕を隠して始める（startFlags.ts）
export const init = (context: Context, flags: Flags = WIDE): Model => {
  const { mode: _mode, snapshot: _snapshot, speakerNames: _speakerNames, ...surface } = MapSurface.init(snapshotAt(context.timeline, context.playback.duration), "review", context.isMac);
  const mapSurface = startingSurface(surface, flags);
  // ツールチップは、ポインタを乗せたらすぐ出す（今の CSS の :hover と同じ）。フォーカスでは Tooltip が遅れずに出す
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

export const surfaceOf = (context: Context, model: Model): MapSurface.Model => ({ mode: "review", snapshot: snapshotOf(context, model), speakerNames: {}, ...model.mapSurface });

// 字幕の部品の Model。字幕の吹き出しはその時刻の発言から毎回導く（ライブと同じ displayBubbles。名前はログで最後に付いたもの）。見返しは名前を変えないので、押せる欄にしない（label を空にする）。字幕を隠しているかは見返しの Model の欄から渡す
const layoutOf = (context: Context, model: Model): SessionLayout.Model => ({
  ...model.sessionLayout,
  captions: { _tag: "Bubbles", bubbles: displayBubbles(settledCaptions(captionBubblesAt(context.timeline, model.playback.time)), model.playback.time, context.timeline.speakerNames).map((b) => ({ ...b, label: Option.none() })) },
  captionsHidden: model.captionsHidden,
  selfPaused: false, // 見返しに自分の休止の一言は出ない
  nameEdit: Option.none(), // 見返しは名前を入力しない
});

type Return = Update.Return<Model, Message>;

export const makeUpdate = (context: Context) => {
  // 表示面の状態のうち、見返しが導く mode・snapshot を除いて保存する（補間 motion も保存し、補間の Subscription が進める）
  const storeSurface = (model: Model, surface: MapSurface.Model): Model => {
    const { mode: _mode, snapshot: _snapshot, speakerNames: _speakerNames, ...next } = surface;
    return modifyFields(model, { mapSurface: () => next });
  };
  // 選択は表示面の viewing が持つので、ノードが選ばれたこと（SelectedNode）は見返しでは受け流す（配線は surfaceFolds）。キーの事実は、表示面の入口（pressViewKey など）で渡す
  const { foldMapSurface, foldEscapeKey, toggleSide: toggledSide, keyHandlers: surfaceKeyHandlers } = surfaceFolds<Model, Message>({
    read: (model) => Option.some(surfaceOf(context, model)),
    write: (model, surface) => storeSurface(model, surface),
    toParentMessage: (message) => Message.GotMapSurfaceMessage({ message }),
  });
  // 字幕の部品（見る状態の知らせの Toast）。導く欄（captions・captionsHidden）は保存しない
  const { foldSessionLayout, foldViewingMode } = SessionLayout.sessionLayoutFolds<Model, Message>({
    read: (model) => Option.some(layoutOf(context, model)),
    write: (model, layout) => {
      const { captions: _captions, captionsHidden: _captionsHidden, ...sessionLayout } = layout;
      return modifyFields(model, { sessionLayout: () => sessionLayout });
    },
    toParentMessage: (message) => Message.GotSessionLayoutMessage({ message }),
  });
  // 子（Slider・Menu・Tooltip）は foldChild で組み込み、結果は OutMessage（ChangedValue・Selected）だけを variant の名前で受ける。子の内部の Message は見ない
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
    // 選ばれた項目の位置で速さを引く（項目は速さの並びの順）。選んだらフォーカスを外す
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
    // 吹き出しが出た・隠れた（Shown・Hidden）ことは、見返しでは受け流す
    foldOutMessage: () => () => (model: Model) => ({ model }),
  });
  // キーの一覧（Popover）。開いているかは Popover の Model が持つ
  const { foldKeyList, foldKeyListOpen, foldKeyListClose } = keyListFolds<Model, Message>({
    read: (model) => Option.some(model.keyList),
    write: (model, keyList) => modifyFields(model, { keyList: () => keyList }),
    toParentMessage: (message) => Message.GotKeyListMessage({ message }),
  });
  // 速さのメニューを外から閉じる（Esc）。選ばれたことの OutMessage は出ない
  const foldRateMenuClose = Update.foldChildStep({
    update: RateMenu.close,
    read: (model: Model) => Option.some(model.rateMenu),
    write: (model: Model, rateMenu: Menu.Model) => modifyFields(model, { rateMenu: () => rateMenu }),
    toParentMessage: (message: Menu.Message) => Message.GotRateMenuMessage({ message }),
    foldOutMessage: () => (model: Model) => ({ model }),
  });
  // 時刻が変わったときだけ <audio> の currentTime に書く（書かないと、次の timeupdate で元の時刻へ戻る）
  // 時刻の変更で Snapshot が別のものになったときは、表示面へ ChangedSnapshot を渡す（大きさを測った後だけ。それ以外は playback だけを更新する）。選んだノードの移り先は見る状態に関わらず決め、カメラを寄せ直すのは自動のときだけ（表示面が決める）
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
  // 録音が会議より長いときは、会議の長さで止めた Model に合わせて <audio> も止める
  const heardTime = (model: Model, time: number): Return => {
    const next = reduce(model, { type: "audioTime", time });
    if (model.playback.playing && !next.playback.playing) return { model: next, commands: [PauseAudio()] };
    return { model: next };
  };
  // AbortError は別の play()/pause() に割り込まれただけなので無視する。止めたあとに届いた失敗で再生が始まらないよう、今も再生中のときだけ止める
  const failedPlay = (model: Model, isAborted: boolean): Return =>
    !isAborted && model.playback.playing ? { model: reduce(model, { type: "toggle" }) } : { model };
  // 速さ・ミュート・音量の変化は、録音つきなら <audio> にも書く。extra は同じ操作で返したい Command（フォーカスを外すなど）
  const changedSettings = (model: Model, event: PlaybackEvent, extra: ReadonlyArray<ReturnType<typeof ReleaseFocus> | ReturnType<typeof ReleaseFocusAfterMenuClose>> = []): Return => {
    const next = reduce(model, event);
    const { rate, muted, volume } = next.playback;
    const commands = [...(hasAudio ? [WriteAudioSettings({ rate, muted, volume })] : []), ...extra];
    return commands.length === 0 ? { model: next } : { model: next, commands };
  };
  // キーの一覧を開閉した結果に、表示面へ「一覧を開閉した」を渡す（10 秒を計り直す。見る状態・カメラは動かさない）。Popover の開閉の後に渡す
  const toggledKeyList = (result: Return): Return => ({ ...result, model: storeSurface(result.model, MapSurface.toggledKeyList(surfaceOf(context, result.model))) });
  // 押したあと、フォーカスを外す
  const released = (model: Model): Return => ({ model, commands: [ReleaseFocus()] });
  // 人が時刻を動かした操作（▶・反映の前後のボタン・シーク・時刻を動かすキー）の結果に、表示面へ「時刻を動かした」を渡す（自動のカメラへ戻る）。再生の reduce の後に渡す
  const byHuman = (result: Return): Return => ({ ...result, model: storeSurface(result.model, MapSurface.movedTime(surfaceOf(context, result.model))) });
  // 右の列・字幕の出し入れ。ボタンと E・C のキーで同じ Model の変化にする（フォーカスを外すのはボタンだけ）。右の列は表示面の見る状態が持つ
  const toggledCaptions = (model: Model): Model => modifyFields(model, { captionsHidden: (hidden) => !hidden });

  // --- キー（#822）。Subscription は「このキーが押された」だけを届け、意味はここで決める ---
  // Esc: 速さのメニューが開いていれば、それを閉じるだけ。キーの一覧が開いていれば、それを閉じるだけ。どちらも閉じていれば見る状態に渡す
  const escapeKey: KeyHandler<Model, Message> = (model, modifiers) =>
    model.rateMenu.isOpen
      ? foldRateMenuClose(model)
      : model.keyList.isOpen
        ? toggledKeyList(foldKeyListClose(model))
        : foldEscapeKey(model, modifiers);
  // 見返しのキーは、再生の出来事にしてから、ボタンと同じ Model の変化と Command にする（⌘・Ctrl・Option と一緒なら出来事にならない）
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
      // 押していないところで離しても（ほかの場所のクリックの pointerup）、フォーカスは外さない
      ReleasedSliderPointer: () => (model.isPressingSlider ? released(modifyFields(model, { isPressingSlider: () => false })) : { model }),
      // 中断された。値は中断時点のまま、子の Slider を Idle に戻してドラッグを終える（押していないところで中断しても何もしない）
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
  // 見る状態の知らせは mode に追従する。mode はキー・ホイール・ドラッグ・10 秒・時刻の移動など多くの入口で変わるので、update の前後を 1 か所で見て渡す
  // 表示する Snapshot の反映番号が変わったら、点滅を最初から再生し直す（同じ key の要素に点滅のクラスが付いたままだと、アニメーションは再生し直されない）。時刻が変わらない update では Snapshot も変わらない
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
              // キーの一覧はマップの区画（.map）の中に出す
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
