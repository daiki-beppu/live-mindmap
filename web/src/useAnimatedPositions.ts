import { useEffect, useRef, useState } from "react";
import type { SnapshotNode } from "../../server/src/core/index.ts";
import type { Position } from "./layout.ts";
import { interpolate, startPositions } from "./motion.ts";

type Positions = Record<string, Position>;

const DURATION_MS = 500;

// 目標の位置が変わるたびに、いま表示している位置から目標へ補間した位置を返す。
// 新しいノードは根元（表示済みの祖先）の位置から伸びる。エッジはノードの位置に沿って描かれる。
export function useAnimatedPositions(nodes: SnapshotNode[], target: Positions): Positions {
  const [shown, setShown] = useState<Positions>({});
  const shownRef = useRef<Positions>({});

  useEffect(() => {
    const start = startPositions(nodes, shownRef.current, target);
    const began = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - began) / DURATION_MS);
      const next = t >= 1 ? target : interpolate(start, target, t);
      shownRef.current = next;
      setShown(next);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [nodes, target]);

  // 補間を始める前の描画でも、新しいノードは目標ではなく根元の位置に置く
  return startPositions(nodes, shown, target);
}
