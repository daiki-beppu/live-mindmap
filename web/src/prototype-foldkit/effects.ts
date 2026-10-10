// 試作（Issue #736）: DOM に触れる部分。Foldkit の属性のハンドラは wheel の量・修飾キー・ジェスチャーを渡さないので、
// マップ要素の Mount で生のイベントを読んで Message にする。<audio> の操作は Command（Mount の引数は差し込んだ時点で固定のため）
import { Duration, Effect, Option, Queue, Schema, Stream } from "effect";
import { Command, Mount, Subscription } from "foldkit";
import { streamFromKeyBindings } from "foldkit/dom";
import { Slider } from "@foldkit/ui";
import { halfWidthKeyOf } from "../imeKey.ts";
import { Message } from "./message.ts";
import type { Model } from "./model.ts";
import { keyBindings } from "./keys.ts";

export const AUDIO_ID = "fk-audio";
const NODE_SELECTOR = "[data-node-id]";

const offer =
  <A, E>(queue: Queue.Queue<A, E>) =>
  (a: A) =>
    void Queue.offerUnsafe(queue, a);

type Of<K extends keyof typeof Message> = (typeof Message)[K] extends { Type: infer T } ? T : never;
type MapMessage = Of<"ResizedMap"> | Of<"MeasuredNodes"> | Of<"Wheeled"> | Of<"ModClicked"> | Of<"Gestured">;

// マップの表示面: 大きさ・ノードの実寸・wheel（量と修飾キー）・⌘/Ctrl＋クリック・Safari のピンチを Message にする
export const ObserveMap = Mount.defineStream("ObserveMap", {
  messages: [Message.ResizedMap, Message.MeasuredNodes, Message.Wheeled, Message.ModClicked, Message.Gestured],
  execute: ({ element }) =>
    Stream.callback<MapMessage>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const emit = offer(queue);
          const el = element as HTMLElement;
          const local = (e: { clientX: number; clientY: number }) => {
            const r = el.getBoundingClientRect();
            return { x: e.clientX - r.left, y: e.clientY - r.top };
          };
          const sizeObserver = new ResizeObserver(() => emit(Message.ResizedMap({ width: el.clientWidth, height: el.clientHeight })));
          sizeObserver.observe(el);
          // ノードの実寸。React Flow と同じく offsetWidth・offsetHeight（倍率の影響を受けない）
          const nodeObserver = new ResizeObserver((entries) => {
            const dims: Record<string, { width: number; height: number }> = {};
            for (const entry of entries) {
              const node = entry.target as HTMLElement;
              const id = node.dataset.nodeId;
              if (id !== undefined && node.isConnected) dims[id] = { width: node.offsetWidth, height: node.offsetHeight };
            }
            if (Object.keys(dims).length > 0) emit(Message.MeasuredNodes({ dims }));
          });
          const observed = new Set<Element>();
          const reconcile = () => {
            const now = new Set(el.querySelectorAll(NODE_SELECTOR));
            for (const node of observed) if (!now.has(node)) (nodeObserver.unobserve(node), observed.delete(node));
            for (const node of now) if (!observed.has(node)) (nodeObserver.observe(node), observed.add(node));
          };
          const mutations = new MutationObserver(reconcile);
          mutations.observe(el, { childList: true, subtree: true });
          reconcile();
          const onWheel = (e: WheelEvent) => {
            if (e.target instanceof Element && e.target.closest(".nowheel")) {
              if (e.ctrlKey) e.preventDefault();
              return;
            }
            e.preventDefault();
            e.stopPropagation();
            emit(Message.Wheeled({ dx: e.deltaX, dy: e.deltaY, deltaMode: e.deltaMode, shift: e.shiftKey, meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, at: e.timeStamp, ...local(e) }));
          };
          // ⌘/Ctrl＋クリックは capture で受けて止める（ノードの上でも根拠を出さない）
          const onClick = (e: MouseEvent) => {
            if (!(e.metaKey || e.ctrlKey)) return;
            e.stopPropagation();
            emit(Message.ModClicked({ alt: e.altKey, ...local(e) }));
          };
          // Safari のトラックパッドのピンチは wheel でなく gesture* で届く（scale は始まりからの倍率）
          let lastScale = 1;
          type Gesture = Event & { scale: number; clientX: number; clientY: number };
          const onGestureStart = (e: Event) => {
            e.preventDefault();
            lastScale = 1;
          };
          const onGestureChange = (e: Event) => {
            e.preventDefault();
            const g = e as Gesture;
            emit(Message.Gestured({ ratio: g.scale / lastScale, ...local(g) }));
            lastScale = g.scale;
          };
          el.addEventListener("wheel", onWheel, { passive: false });
          el.addEventListener("click", onClick, { capture: true });
          el.addEventListener("gesturestart", onGestureStart);
          el.addEventListener("gesturechange", onGestureChange);
          return () => {
            sizeObserver.disconnect();
            nodeObserver.disconnect();
            mutations.disconnect();
            el.removeEventListener("wheel", onWheel);
            el.removeEventListener("click", onClick, { capture: true });
            el.removeEventListener("gesturestart", onGestureStart);
            el.removeEventListener("gesturechange", onGestureChange);
          };
        }),
        (release) => Effect.sync(release),
      ).pipe(Effect.andThen(Effect.never)),
    ),
});

// <audio>: 時刻（timeupdate。背景のタブでは rAF が止まるので）と、終わり
export const ObserveAudio = Mount.defineStream("ObserveAudio", {
  messages: [Message.TimedAudio, Message.EndedAudio],
  execute: ({ element }) =>
    Stream.callback<Of<"TimedAudio"> | Of<"EndedAudio">>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const audio = element as HTMLAudioElement;
          audio.preservesPitch = true;
          const onTime = () => offer(queue)(Message.TimedAudio({ time: audio.currentTime }));
          const onEnded = () => offer(queue)(Message.EndedAudio());
          audio.addEventListener("timeupdate", onTime);
          audio.addEventListener("ended", onEnded);
          return () => {
            audio.removeEventListener("timeupdate", onTime);
            audio.removeEventListener("ended", onEnded);
          };
        }),
        (release) => Effect.sync(release),
      ).pipe(Effect.andThen(Effect.never)),
    ),
});

// シークバーの上のポインタの位置の値（章名・時刻のプレビュー用。@foldkit/ui の Slider には無い）
export const ObserveSeekPointer = Mount.defineStream("ObserveSeekPointer", {
  args: { max: Schema.Number },
  messages: [Message.PointedSeek],
  execute: ({ element, max }) =>
    Stream.callback<Of<"PointedSeek">>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const onMove = (e: PointerEvent) => {
            const r = element.getBoundingClientRect();
            const f = r.width > 0 ? Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) : 0;
            offer(queue)(Message.PointedSeek({ value: f * max }));
          };
          const onLeave = () => offer(queue)(Message.PointedSeek({ value: null }));
          element.addEventListener("pointermove", onMove as EventListener);
          element.addEventListener("pointerleave", onLeave);
          return () => {
            element.removeEventListener("pointermove", onMove as EventListener);
            element.removeEventListener("pointerleave", onLeave);
          };
        }),
        (release) => Effect.sync(release),
      ).pipe(Effect.andThen(Effect.never)),
    ),
});

const audioElement = () => Option.fromNullishOr(document.getElementById(AUDIO_ID) as HTMLAudioElement | null);
const withAudio = (f: (a: HTMLAudioElement) => void) => Effect.sync(() => (Option.map(audioElement(), f), Message.CompletedDom()));

export const PlayAudio = Command.define("PlayAudio", {
  messages: [Message.CompletedDom, Message.FailedPlay],
  execute: Effect.suspend(() => {
    const audio = audioElement();
    if (Option.isNone(audio)) return Effect.succeed(Message.CompletedDom());
    return Effect.tryPromise(() => audio.value.play()).pipe(
      Effect.as(Message.CompletedDom()),
      Effect.catch((e) => Effect.succeed(e.cause instanceof DOMException && e.cause.name === "AbortError" ? Message.CompletedDom() : Message.FailedPlay())),
    );
  }),
});
export const PauseAudio = Command.define("PauseAudio", { messages: [Message.CompletedDom], execute: withAudio((a) => a.pause()) });
export const SeekAudio = Command.define("SeekAudio", {
  args: { time: Schema.Number },
  messages: [Message.CompletedDom],
  execute: ({ time }) => withAudio((a) => (a.currentTime = time)),
});
// 速さ・ミュート・音量。defaultPlaybackRate も書いて、読み込み直しで 1 倍に戻らないようにする
export const SyncAudio = Command.define("SyncAudio", {
  args: { rate: Schema.Number, muted: Schema.Boolean, volume: Schema.Number },
  messages: [Message.CompletedDom],
  execute: ({ rate, muted, volume }) =>
    withAudio((a) => {
      a.defaultPlaybackRate = rate;
      a.playbackRate = rate;
      a.muted = muted;
      a.volume = volume;
    }),
});
// 押して離したら、操作の行のフォーカスを外す（矢印キーなどがシークバーに奪われたままにならないように）
export const BlurActive = Command.define("BlurActive", {
  messages: [Message.CompletedDom],
  execute: Effect.sync(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
    return Message.CompletedDom();
  }),
});

// target は Stream を張るときに引く（テストの環境には window・document が無い）
const fromWindow = <E extends Event>(targetOf: () => EventTarget, type: string, f: (e: E) => Option.Option<Message>, capture = false) =>
  Stream.callback<Message>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const target = targetOf();
        const listener = (e: Event) => Option.map(f(e as E), offer(queue));
        target.addEventListener(type, listener, { capture });
        return () => target.removeEventListener(type, listener, { capture });
      }),
      (release) => Effect.sync(release),
    ).pipe(Effect.andThen(Effect.never)),
  );

// 日本語入力オンのキーを半角のキーにして、元の target へ送り直す（キーの照合は isComposing・全角のキーを捨てるため）
const imeRedispatch = fromWindow<KeyboardEvent>(
  () => window,
  "keydown",
  (e) => {
    const out = halfWidthKeyOf(e);
    if (out === null || e.target === null) return Option.none();
    e.preventDefault();
    e.stopImmediatePropagation();
    e.target.dispatchEvent(new KeyboardEvent("keydown", { ...out, repeat: e.repeat, location: e.location, bubbles: true, cancelable: true, composed: true }));
    return Option.none();
  },
  true,
);

// 補間中・再生中（音声つきは <audio> の currentTime を毎フレーム読む）だけ回す rAF
const audioFrames = Stream.callback<Message>((queue) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      let frame = requestAnimationFrame(function tick() {
        Option.map(audioElement(), (a) => offer(queue)(Message.TimedAudio({ time: a.currentTime })));
        frame = requestAnimationFrame(tick);
      });
      return () => cancelAnimationFrame(frame);
    }),
    (release) => Effect.sync(release),
  ).pipe(Effect.andThen(Effect.never)),
);

const REVIEW_IDLE = Duration.seconds(10);

export const makeSubscriptions = (audio: boolean) => {
  const own = Subscription.make<Model, Message>()((entry) => ({
    keys: entry(
      { hasSelection: Schema.Boolean },
      {
        modelToDependencies: (m) => ({ hasSelection: m.viewing.selection !== undefined }),
        dependenciesToStream: ({ hasSelection }) => streamFromKeyBindings({ bindings: keyBindings(hasSelection, audio) }),
      },
    ),
    ime: { ...Subscription.persistentEntry(imeRedispatch), modelToDependencies: () => ({}) },
    frame: Subscription.animationFrameEntry<Model, Message>({
      isActive: (m) => m.anim !== null || (m.playback.playing && !audio),
      toMessage: (dt) => Message.TickedFrame({ dt }),
    }),
    audioClock: entry(
      { active: Schema.Boolean },
      {
        modelToDependencies: (m) => ({ active: audio && m.playback.playing }),
        dependenciesToStream: ({ active }) => (active ? audioFrames : Stream.empty),
      },
    ),
    pointer: entry(
      { dragging: Schema.Boolean },
      {
        modelToDependencies: (m) => ({ dragging: m.drag !== null }),
        dependenciesToStream: ({ dragging }) =>
          dragging
            ? Stream.merge(
                fromWindow<PointerEvent>(() => document, "pointermove", (e) => Option.some(Message.MovedPointer({ x: e.screenX, y: e.screenY }))),
                Stream.merge(
                  fromWindow(() => document, "pointerup", () => Option.some(Message.ReleasedPointer())),
                  fromWindow(() => document, "pointercancel", () => Option.some(Message.ReleasedPointer())),
                ),
              )
            : Stream.empty,
      },
    ),
    // 見返しで人が止めている間、最後の操作から 10 秒たったら自動に戻す。seq が変わるたびに張り直す（計り直し）
    idle: entry(
      { manual: Schema.Boolean, seq: Schema.Number },
      {
        modelToDependencies: (m) => ({ manual: m.viewing.mode === "manual", seq: m.idleSeq }),
        dependenciesToStream: ({ manual }) => (manual ? Stream.fromEffect(Effect.as(Effect.sleep(REVIEW_IDLE), Message.Idled())) : Stream.empty),
      },
    ),
    rateMenu: entry(
      { open: Schema.Boolean },
      {
        modelToDependencies: (m) => ({ open: m.rateMenuOpen }),
        dependenciesToStream: ({ open }) =>
          open
            ? fromWindow<PointerEvent>(() => document, "pointerdown", (e) =>
                e.target instanceof Element && e.target.closest(".review-rate") ? Option.none() : Option.some(Message.ClosedRateMenu()),
              )
            : Stream.empty,
      },
    ),
  }));
  const seek = Subscription.lift({ seekPointer: Slider.subscriptions.dragPointer, seekEscape: Slider.subscriptions.dragEscape })<Model, Message>({
    read: (m) => Option.some(m.seekSlider),
    toParentMessage: (message) => Message.GotSeekSlider({ message }),
  });
  const volume = Subscription.lift({ volumePointer: Slider.subscriptions.dragPointer, volumeEscape: Slider.subscriptions.dragEscape })<Model, Message>({
    read: (m) => Option.some(m.volumeSlider),
    toParentMessage: (message) => Message.GotVolumeSlider({ message }),
  });
  return Subscription.aggregate(own, seek, volume);
};
