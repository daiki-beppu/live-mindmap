// マップの表示面の要素の Mount。画面の大きさ（ResizeObserver）とノードの高さ（ResizeObserver）を測り、1 つの Message にして届ける。
// 1 つの要素に OnMount は 1 つだけなので、後の issue（パン・ズーム）は同じ Mount に足す
import { Effect, Queue, Stream } from "effect";
import { Mount } from "foldkit";
import { Message } from "./message.ts";

const NODE_SELECTOR = "[data-node-id]";

type Measured = typeof Message.MeasuredMapSurface.Type;

export const ObserveMapSurface = Mount.defineStream("ObserveMapSurface", {
  messages: [Message.MeasuredMapSurface],
  execute: ({ element }) =>
    Stream.callback<Measured>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const surface = element as HTMLElement;
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
          return () => {
            sizeObserver.disconnect();
            nodeObserver.disconnect();
            mutations.disconnect();
          };
        }),
        (release) => Effect.sync(release),
      ).pipe(Effect.andThen(Effect.never)),
    ),
});
