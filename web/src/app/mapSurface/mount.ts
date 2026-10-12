// マップの表示面の要素の Mount。画面の大きさ（ResizeObserver）とノードの高さ（ResizeObserver）を測り、生のイベント（押した・ノードの click・wheel・修飾付きの click・gesture）とあわせて、起きた事実だけを Message にして届ける。
// パンの量・軸・クリックかドラッグかの判定はここでしない（update が行う）。1 つの要素に OnMount は 1 つだけなので、ズーム（Issue #816）も同じ Mount で受け、倍率・比は計算しない
import { Effect, Option, Queue, Stream } from "effect";
import { Dom, Mount } from "foldkit";
import { MAP_NODE_BUTTON_CLASS } from "../../enterFold.ts";
import { Message } from "./message.ts";

const NODE_SELECTOR = "[data-node-id]";
const NO_PAN_SELECTOR = ".nopan";
const NODE_BUTTON_SELECTOR = `.${MAP_NODE_BUTTON_CLASS}`;

type Emitted =
  | typeof Message.MeasuredMapSurface.Type
  | typeof Message.PressedMapSurface.Type
  | typeof Message.PressedNodeButton.Type
  | typeof Message.ClickedNodeButton.Type
  | typeof Message.ClickedMapSurfaceWithModifier.Type
  | typeof Message.StartedMapSurfaceGesture.Type
  | typeof Message.ChangedMapSurfaceGesture.Type;

// Safari の gesture のイベント（TS のイベント表に無い）。scale は始まりからの累積の倍率
type GestureEvent = Event & { scale: number; clientX: number; clientY: number };

// イベントの対象になったノードのボタンと、そのノードの id。ノードのボタンの上でなければ null
const nodeButtonOf = (target: EventTarget | null): { button: HTMLElement; nodeId: string } | null => {
  const button = target instanceof Element ? target.closest<HTMLElement>(NODE_BUTTON_SELECTOR) : null;
  const nodeId = button?.closest<HTMLElement>(NODE_SELECTOR)?.dataset.nodeId;
  return button !== null && nodeId !== undefined ? { button, nodeId } : null;
};

export const ObserveMapSurface = Mount.defineStream("ObserveMapSurface", {
  messages: [Message.MeasuredMapSurface, Message.PressedMapSurface, Message.PressedNodeButton, Message.ClickedNodeButton, Message.WheeledMapSurface, Message.ClickedMapSurfaceWithModifier, Message.StartedMapSurfaceGesture, Message.ChangedMapSurfaceGesture],
  execute: ({ element }) =>
    Stream.merge(
      // wheel は preventDefault を効かせるため、リスナーの中で同期して行う（passive: false）。ノードの上でも受ける
      Dom.streamFromEventFilterMapPreventDefault({
        target: element,
        type: "wheel",
        filterMapEvent: (event) => {
          const origin = (element as HTMLElement).getBoundingClientRect();
          return Option.some(
            Message.WheeledMapSurface({
              x: event.clientX - origin.left,
              y: event.clientY - origin.top,
              deltaX: event.deltaX,
              deltaY: event.deltaY,
              deltaMode: event.deltaMode,
              shiftKey: event.shiftKey,
              ctrlKey: event.ctrlKey,
              metaKey: event.metaKey,
              timeStamp: event.timeStamp,
            }),
          );
        },
      }),
      observeSurface(element as HTMLElement),
    ),
});

const observeSurface = (surface: HTMLElement): Stream.Stream<Emitted> =>
  Stream.callback<Emitted>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const emit = (nodeHeights: Record<string, number>) => {
          Queue.offerUnsafe(queue, Message.MeasuredMapSurface({ width: surface.offsetWidth, height: surface.offsetHeight, nodeHeights }));
        };
        // 大きさは React Flow と同じく offsetWidth・offsetHeight（倍率の影響を受けない）
        const sizeObserver = new ResizeObserver(() => emit({}));
        sizeObserver.observe(surface);
        const nodeObserver = new ResizeObserver((entries) => {
          const nodeHeights: Record<string, number> = {};
          for (const entry of entries) {
            const node = entry.target as HTMLElement;
            const id = node.dataset.nodeId;
            // 実際の高さ（小数）。倍率の影響を受けない CSS の高さを読む（offsetHeight は整数に丸める。丸めた高さは配置とカメラが、小数のままの高さはエッジの端点が使う）
            if (id !== undefined && node.isConnected) nodeHeights[id] = Number.parseFloat(getComputedStyle(node).height);
          }
          if (Object.keys(nodeHeights).length > 0) emit(nodeHeights);
        });
        // 増えた・減ったノードの要素に合わせて、測る対象を入れ替える
        const observed = new Set<Element>();
        const reconcile = () => {
          const present = new Set(surface.querySelectorAll(NODE_SELECTOR));
          for (const node of observed) {
            if (present.has(node)) continue;
            nodeObserver.unobserve(node);
            observed.delete(node);
          }
          for (const node of present) {
            if (observed.has(node)) continue;
            nodeObserver.observe(node);
            observed.add(node);
          }
        };
        const mutations = new MutationObserver(reconcile);
        mutations.observe(surface, { childList: true, subtree: true });
        reconcile();
        const onPointerDown = (event: PointerEvent) => {
          const target = event.target instanceof Element ? event.target : null;
          Queue.offerUnsafe(
            queue,
            Message.PressedMapSurface({ clientX: event.clientX, clientY: event.clientY, button: event.button, ctrlKey: event.ctrlKey, insideNoPan: target?.closest(NO_PAN_SELECTOR) != null }),
          );
          const pressed = nodeButtonOf(event.target);
          if (pressed === null) return;
          // ポインタをボタンに固定する。固定しないと、ボタンの外で離したときに click がボタンへ届かず、押した記録が残る
          pressed.button.setPointerCapture(event.pointerId);
          Queue.offerUnsafe(queue, Message.PressedNodeButton({ nodeId: pressed.nodeId, clientX: event.clientX, clientY: event.clientY }));
        };
        const onClick = (event: MouseEvent) => {
          const clicked = nodeButtonOf(event.target);
          if (clicked !== null) Queue.offerUnsafe(queue, Message.ClickedNodeButton({ nodeId: clicked.nodeId, clientX: event.clientX, clientY: event.clientY }));
        };
        // ⌘/Ctrl＋click は capture で受け、ノードの選択に届かないよう同期して止める
        const onClickCapture = (event: MouseEvent) => {
          if (!event.metaKey && !event.ctrlKey) return;
          event.stopPropagation();
          const origin = surface.getBoundingClientRect();
          Queue.offerUnsafe(queue, Message.ClickedMapSurfaceWithModifier({ x: event.clientX - origin.left, y: event.clientY - origin.top, ctrlKey: event.ctrlKey, metaKey: event.metaKey, altKey: event.altKey }));
        };
        // gesture はページ全体のズームを止めるため、リスナーの中で同期して preventDefault する
        const onGestureStart = (event: Event) => {
          event.preventDefault();
          Queue.offerUnsafe(queue, Message.StartedMapSurfaceGesture());
        };
        const onGestureChange = (event: Event) => {
          event.preventDefault();
          const { scale, clientX, clientY } = event as GestureEvent;
          const origin = surface.getBoundingClientRect();
          Queue.offerUnsafe(queue, Message.ChangedMapSurfaceGesture({ scale, x: clientX - origin.left, y: clientY - origin.top }));
        };
        surface.addEventListener("pointerdown", onPointerDown);
        surface.addEventListener("click", onClick);
        surface.addEventListener("click", onClickCapture, { capture: true });
        surface.addEventListener("gesturestart", onGestureStart);
        surface.addEventListener("gesturechange", onGestureChange);
        return () => {
          surface.removeEventListener("pointerdown", onPointerDown);
          surface.removeEventListener("click", onClick);
          surface.removeEventListener("click", onClickCapture, { capture: true });
          surface.removeEventListener("gesturestart", onGestureStart);
          surface.removeEventListener("gesturechange", onGestureChange);
          sizeObserver.disconnect();
          nodeObserver.disconnect();
          mutations.disconnect();
        };
      }),
      (release) => Effect.sync(release),
    ).pipe(Effect.andThen(Effect.never)),
  );
