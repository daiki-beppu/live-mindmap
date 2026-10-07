import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { CSSProperties, MouseEvent, PointerEvent } from "react";

export type MapNodeData = {
  text: string;
  color: string;
  mark: string | null;
  rejected: boolean;
  fold: { hint: string | null; hidden: number } | null; // 畳んだノード（まとめのノードを含む）の手がかりの文字と隠れた数。畳んでいなければ null
  changedRound: number | null; // 今回の反映で変わったなら、その反映の round（点滅の強調）
  selected: boolean; // 右の列に根拠を出している
  onSelect: (nodeId: string) => void;
};

// ドラッグでない click とみなす、押した位置からの最大の移動量（px）
const CLICK_SLOP = 4;
// 押した位置。ドラッグの後の click で根拠を出さないために、click で使い切る
const pressedAt = new WeakMap<EventTarget, { x: number; y: number; dragged: boolean }>();

const onPointerDown = (e: PointerEvent<HTMLButtonElement>) => {
  // ポインタをボタンに固定する。固定しないと、ボタンの外へ出た間の pointermove が届かず、ドラッグを検出できない
  e.currentTarget.setPointerCapture(e.pointerId);
  pressedAt.set(e.currentTarget, { x: e.clientX, y: e.clientY, dragged: false });
};

// 離したときに ⌘/Ctrl が付いていれば、続く click はマップの拡大・縮小に使われ onClick へ届かない。記録を残すと後のキーボードの click がドラッグ扱いになる。押した時の修飾キーでは決まらないので、押した時は常に記録する
const onPointerUp = (e: PointerEvent<HTMLButtonElement>) => {
  if (e.metaKey || e.ctrlKey) pressedAt.delete(e.currentTarget);
};

// 途中でしきい値を超えたら、離した位置が押した位置の近くでもドラッグとして扱う（ボタンの外へ出た移動もキャプチャで届く）
const onPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
  const from = pressedAt.get(e.currentTarget);
  if (from && Math.hypot(e.clientX - from.x, e.clientY - from.y) > CLICK_SLOP) from.dragged = true;
};

// 押した位置から離れて離した click（画面を動かすドラッグ）では選ばない。押した記録がない click（キーボード）は選ぶ
function onClick(e: MouseEvent<HTMLButtonElement>, select: () => void) {
  const from = pressedAt.get(e.currentTarget);
  pressedAt.delete(e.currentTarget);
  if (from && (from.dragged || Math.hypot(e.clientX - from.x, e.clientY - from.y) > CLICK_SLOP)) return;
  select();
}

// 受け取った値を描き、クリックは onSelect で通知するだけ（表示専用）。
export function MapNode({ id, data }: NodeProps<Node<MapNodeData, "map">>) {
  return (
    // 反映ごとに key を変えて要素を作り直し、点滅のアニメーションを頭からやり直す
    <div
      key={data.changedRound ?? "steady"}
      className={["map-node", data.rejected && "map-node--rejected", data.fold && "map-node--folded", data.selected && "map-node--selected", data.changedRound !== null && "map-node--blink", "nopan"].filter(Boolean).join(" ")}
      style={{ "--kind-color": data.color } as CSSProperties}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <button type="button" className="map-node__button" aria-pressed={data.selected} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onClick={(e) => onClick(e, () => data.onSelect(id))}>
        {data.mark && <span className="map-node__mark">{data.mark}</span>}
        <span className="map-node__text">{data.text}</span>
        {data.fold?.hint && <span className="map-node__hint">{data.fold.hint}</span>}
      </button>
      {data.fold && <span className="map-node__count">{data.fold.hidden}</span>}
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}
