// マップの表示面の要素の Mount。画面の大きさ（ResizeObserver）とノードの高さ（ResizeObserver）を測り、生のイベント（押した・ノードの click・wheel）とあわせて、起きた事実だけを Message にして届ける。
// パンの量・軸・クリックかドラッグかの判定はここでしない（update が行う）。1 つの要素に OnMount は 1 つだけなので、後の issue（ズーム）は同じ Mount に足す
import { Effect, Option, Queue, Stream } from "effect";
import { Dom, Mount } from "foldkit";
import { MAP_NODE_BUTTON_CLASS } from "../../enterFold.ts";
import { Message } from "./message.ts";

const NODE_SELECTOR = "[data-node-id]";
const NO_PAN_SELECTOR = ".nopan";
const NODE_BUTTON_SELECTOR = `.${MAP_NODE_BUTTON_CLASS}`;

type Emitted = typeof Message.MeasuredMapSurface.Type | typeof Message.PressedMapSurface.Type | typeof Message.PressedNodeButton.Type | typeof Message.ClickedNodeButton.Type;

// イベントの対象になったノードのボタンと、そのノードの id。ノードのボタンの上でなければ null
const nodeButtonOf = (target: EventTarget | null): { button: HTMLElement; nodeId: string } | null => {
  const button = target instanceof Element ? target.closest<HTMLElement>(NODE_BUTTON_SELECTOR) : null;
  const nodeId = button?.closest<HTMLElement>(NODE_SELECTOR)?.dataset.nodeId;
  return button !== null && nodeId !== undefined ? { button, nodeId } : null;
};

export const ObserveMapSurface = Mount.defineStream("ObserveMapSurface", {
  messages: [Message.MeasuredMapSurface, Message.PressedMapSurface, Message.PressedNodeButton, Message.ClickedNodeButton, Message.WheeledMapSurface],
  execute: ({ element }) =>
    Stream.merge(
      // wheel は preventDefault を効かせるため、リスナーの中で同期して行う（passive: false）。ノードの上でも受ける
      Dom.streamFromEventFilterMapPreventDefault({
        target: element,
        type: "wheel",
        filterMapEvent: (event) =>
          Option.some(
            Message.WheeledMapSurface({
              deltaX: event.deltaX,
              deltaY: event.deltaY,
              deltaMode: event.deltaMode,
              shiftKey: event.shiftKey,
              ctrlKey: event.ctrlKey,
              metaKey: event.metaKey,
              timeStamp: event.timeStamp,
            }),
          ),
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
            if (id !== undefined && node.isConnected) nodeHeights[id] = node.offsetHeight;
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
        surface.addEventListener("pointerdown", onPointerDown);
        surface.addEventListener("click", onClick);
        return () => {
          surface.removeEventListener("pointerdown", onPointerDown);
          surface.removeEventListener("click", onClick);
          sizeObserver.disconnect();
          nodeObserver.disconnect();
          mutations.disconnect();
        };
      }),
      (release) => Effect.sync(release),
    ).pipe(Effect.andThen(Effect.never)),
  );
