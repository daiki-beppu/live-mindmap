// 試作（Issue #736）: Foldkit 版の見返しの update。再生（reviewPlayback）・見る状態（viewing）・カメラ（mapCamera）を 1 本の update にまとめる
import type { Update } from "foldkit";
import { Slider } from "@foldkit/ui";
import { scrollAlongAxis, scrollAxis, zoomAtPoint, CLICK_ZOOM_FACTOR } from "../camera.ts";
import { pointedNode } from "../folding.ts";
import { relocations } from "../relocation.ts";
import { reviewKeyEvent } from "../reviewKeys.ts";
import { playbackReducer, type PlaybackEvent, type PlaybackState } from "../reviewPlayback.ts";
import { snapshotAt } from "../reviewTimeline.ts";
import { humanSetsOf } from "../viewing.ts";
import { BlurActive, PauseAudio, PlayAudio, SeekAudio, SyncAudio } from "./effects.ts";
import { advanceFrame, autoCamera, reanchor, rederive, resized, userMove, viewingEvent, zoomAt } from "./mapCamera.ts";
import { Message } from "./message.ts";
import type { Context, Model } from "./model.ts";

type Return = Update.Return<Model, Message>;
type Commands = NonNullable<Return["commands"]>;

// ドラッグでない click とみなす、押した位置からの最大の移動量（px）
const CLICK_SLOP = 4;
const NO_MODS = { meta: false, ctrl: false, alt: false };

export function makeUpdate(ctx: Context) {
  // 時刻を変える。スナップショットが変われば見せ方を作り直して自動のカメラを当て、round が進んだ（戻った）ら反映として知らせる
  const setTime = (m: Model, playback: PlaybackState): Model => {
    const snapshot = snapshotAt(ctx.timeline, playback.time);
    if (snapshot === m.d.snapshot) return { ...m, playback };
    const next = autoCamera(rederive({ ...m, playback }, snapshot));
    if (snapshot.round === m.d.snapshot.round) return next;
    return viewingEvent(next, { type: "reflect", replaced: relocations(m.previous, { tree: next.d.tree, snapshot }) });
  };
  const playback = (m: Model, event: PlaybackEvent) => setTime(m, playbackReducer(m.playback, event, ctx.playback));
  // 人が時刻を動かした（▶・シーク・反映の前後・キー）。音声つきは currentTime も書く
  const operate = (m: Model, event: PlaybackEvent): Return => {
    const next = playbackReducer(m.playback, event, ctx.playback);
    const moved = viewingEvent(setTime(m, next), { type: "timeMoved" });
    return { model: moved, commands: ctx.audio && next.time !== m.playback.time ? [SeekAudio({ time: next.time })] : [] };
  };
  const reviewKey = (m: Model, action: typeof Message.PressedReviewKey.Type["action"]): Return => {
    const key = reviewKeyEvent(action, NO_MODS, m.playback.time, ctx.timeline.duration);
    if (key === null) return { model: m };
    return key.movesTime ? operate(m, key.event) : { model: playback(m, key.event) };
  };
  const view = (m: Model, event: Parameters<typeof viewingEvent>[1]): Return => ({ model: viewingEvent(m, event) });

  const step = (m: Model, message: Message): Return =>
    Message.match<Return>(message, {
      MeasuredNodes: ({ dims }) => {
        const changed = Object.entries(dims).some(([id, d]) => m.dims[id]?.width !== d.width || m.dims[id]?.height !== d.height);
        return { model: changed ? reanchor(autoCamera(rederive({ ...m, dims: { ...m.dims, ...dims } }))) : m };
      },
      ResizedMap: ({ width, height }) => ({ model: resized(m, { width, height }) }),
      Wheeled: (w) => {
        const point = { x: w.x, y: w.y };
        if ((w.meta || w.ctrl) && w.shift) {
          const delta = { x: w.dx, y: w.dy };
          const lock = scrollAxis(m.axisLock, w.at, delta);
          return { model: userMove({ ...m, axisLock: lock }, scrollAlongAxis(m.viewport, lock.axis, delta)) };
        }
        if (w.ctrl || w.meta) {
          // React Flow（d3-zoom）と同じ量: macOS のピンチ（ctrlKey 付き）は 10 倍
          const factor = w.ctrl && ctx.isMac ? 10 : 1;
          const delta = -w.dy * (w.deltaMode === 1 ? 0.05 : w.deltaMode ? 1 : 0.002) * factor;
          return { model: userMove(m, zoomAt(m, point, 2 ** delta)) };
        }
        const n = w.deltaMode === 1 ? 20 : 1;
        const [dx, dy] = !ctx.isMac && w.shift ? [w.dy * n, 0] : [w.dx * n, w.dy * n];
        return { model: userMove(m, { ...m.viewport, x: m.viewport.x - dx * 0.5, y: m.viewport.y - dy * 0.5 }) };
      },
      Gestured: ({ ratio, x, y }) => ({ model: userMove(m, zoomAt(m, { x, y }, ratio)) }),
      ModClicked: ({ x, y, alt }) => {
        const moved = userMove(m, m.viewport);
        return { model: { ...moved, viewport: zoomAtPoint(moved.viewport, { x, y }, alt ? 1 / CLICK_ZOOM_FACTOR : CLICK_ZOOM_FACTOR) } };
      },
      // 何もないところを押したら（React Flow の onMoveStart と同じく）人の操作として止める
      PressedPane: ({ x, y }) => ({ model: userMove({ ...m, drag: { kind: "pane", x, y } }, m.viewport) }),
      PressedNode: ({ id, x, y }) => ({ model: { ...m, drag: { kind: "node", id, x0: x, y0: y, dragged: false }, lastPress: null } }),
      MovedPointer: ({ x, y }) => {
        const drag = m.drag;
        if (drag?.kind === "pane") return { model: userMove({ ...m, drag: { kind: "pane", x, y } }, { ...m.viewport, x: m.viewport.x + x - drag.x, y: m.viewport.y + y - drag.y }) };
        if (drag?.kind === "node" && !drag.dragged && Math.hypot(x - drag.x0, y - drag.y0) > CLICK_SLOP) return { model: { ...m, drag: { ...drag, dragged: true } } };
        return { model: m };
      },
      // ボタンの上で離した: 押した位置からの移動量でも決める（文書の pointermove の Subscription は張り終わるまで届かない）
      ReleasedNode: ({ id, x, y }) => {
        if (m.drag?.kind !== "node" || m.drag.id !== id) return { model: m };
        return { model: { ...m, drag: null, lastPress: { id, dragged: m.drag.dragged || Math.hypot(x - m.drag.x0, y - m.drag.y0) > CLICK_SLOP } } };
      },
      ReleasedPointer: () => ({ model: { ...m, drag: null, lastPress: m.drag?.kind === "node" ? { id: m.drag.id, dragged: m.drag.dragged } : m.lastPress } }),
      // 押した位置から離れて離した click では選ばない。押した記録がない click（キーボード）は選ぶ。まとめのノードは選ばない
      ClickedNode: ({ id }) => {
        const cleared = { ...m, lastPress: null };
        if ((m.lastPress?.id === id && m.lastPress.dragged) || m.d.view.summaries.has(id)) return { model: cleared };
        return view(cleared, { type: "select", id });
      },
      ClickedFoldDot: ({ id }) => view(m, { type: "foldDot", id }),
      ClickedEdgeDot: ({ id }) => view(m, { type: "edgeDot", id }),
      ClickedChange: ({ id }) => {
        const { opened, folded, unbundled } = humanSetsOf(m.viewing);
        const found = pointedNode(m.d.snapshot, id, opened, folded, unbundled);
        return view(m, found === null ? { type: "select", id } : { type: "pointChange", id, ...found });
      },
      TickedFrame: ({ dt }) => {
        const played = m.playback.playing && !ctx.audio ? playback(m, { type: "elapsed", seconds: dt / 1000 }) : m;
        return { model: advanceFrame(played, dt) };
      },
      Idled: () => view(m, { type: "idle" }),
      PressedViewKey: ({ key }) => view(m, { type: "key", key, ...NO_MODS }),
      PressedArrow: ({ dir }) => view(m, { type: "arrow", dir, ...NO_MODS }),
      PressedEnter: () => view(m, { type: "enter", ...NO_MODS }),
      // 速さのメニューが開いている間の Esc は、メニューを閉じるだけ
      PressedEscape: () => (m.rateMenuOpen ? { model: { ...m, rateMenuOpen: false } } : view(m, { type: "escape", ...NO_MODS })),
      PressedKeyList: () => view(m, { type: "keyList", ...NO_MODS }),
      PressedSide: () => view(m, { type: "side", ...NO_MODS }),
      PressedCaptions: () => view(m, { type: "captions", ...NO_MODS }),
      PressedReviewKey: ({ action }) => reviewKey(m, action),
      IgnoredKey: () => ({ model: m }),
      ClickedToggle: () => operate(m, { type: "toggle" }),
      ClickedPrev: () => operate(m, { type: "prev" }),
      ClickedNext: () => operate(m, { type: "next" }),
      ClickedMute: () => ({ model: playback(m, { type: "toggleMute" }), commands: [BlurActive()] }),
      ClickedCaptions: () => ({ model: viewingEvent(m, { type: "captions", ...NO_MODS }), commands: [BlurActive()] }),
      ClickedSide: () => ({ model: viewingEvent(m, { type: "side", ...NO_MODS }), commands: [BlurActive()] }),
      ToggledRateMenu: () => ({ model: { ...m, rateMenuOpen: !m.rateMenuOpen } }),
      ChoseRate: ({ rate }) => ({ model: { ...playback(m, { type: "setRate", rate }), rateMenuOpen: false }, commands: [BlurActive()] }),
      ClosedRateMenu: () => ({ model: { ...m, rateMenuOpen: false } }),
      PointedSeek: ({ value }) => ({ model: { ...m, seekPointer: value } }),
      GotSeekSlider: ({ message: inner }) => {
        const r = Slider.update(m.seekSlider, inner);
        const base = { ...m, seekSlider: r.model };
        const out = r.outMessage ? operate(base, { type: "seek", time: r.outMessage.value }) : { model: base };
        return inner._tag === "ReleasedDragPointer" ? { ...out, commands: [...(out.commands ?? []), BlurActive()] } : out;
      },
      GotVolumeSlider: ({ message: inner }) => {
        const r = Slider.update(m.volumeSlider, inner);
        const base = { ...m, volumeSlider: r.model };
        const model = r.outMessage ? playback(base, { type: "setVolume", volume: r.outMessage.value }) : base;
        return { model, commands: inner._tag === "ReleasedDragPointer" ? [BlurActive()] : [] };
      },
      TimedAudio: ({ time }) => ({ model: playback(m, { type: "audioTime", time }) }),
      EndedAudio: () => ({ model: playback(m, { type: "ended" }) }),
      // play() が断られたら（AbortError 以外）、画面を止めた状態に戻す
      FailedPlay: () => ({ model: playback(m, { type: "toggle" }) }),
      CompletedDom: () => ({ model: m }),
    });

  // <audio> へ、鳴らす・止める・速さ・ミュート・音量の変化を Command で書く。前の木（選択の移り先を求める元）も更新する
  return (m: Model, message: Message): Return => {
    const out = step(m, message);
    const next = out.model;
    const commands: Array<Commands[number]> = [...(out.commands ?? [])];
    if (ctx.audio) {
      const [a, b] = [m.playback, next.playback];
      if (a.playing !== b.playing) commands.push(b.playing ? PlayAudio() : PauseAudio());
      if (a.rate !== b.rate || a.muted !== b.muted || a.volume !== b.volume) commands.push(SyncAudio({ rate: b.rate, muted: b.muted, volume: b.volume }));
    }
    const selectedId = next.viewing.selection?.id ?? null;
    const prev = next.previous;
    const model =
      prev.tree === next.d.tree && prev.snapshot === next.d.snapshot && prev.selectedId === selectedId ? next : { ...next, previous: { tree: next.d.tree, snapshot: next.d.snapshot, selectedId } };
    return { model, commands };
  };
}

