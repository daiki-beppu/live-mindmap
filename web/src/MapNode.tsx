import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { CSSProperties } from "react";

export type MapNodeData = {
  text: string;
  color: string;
  mark: string | null;
  rejected: boolean;
  changedRound: number | null; // 今回の反映で変わったなら、その反映の round（塗りの強調）
  root: boolean; // 会議の名前のノード（文字を中央揃えにする）
  selected: boolean; // 右の列に根拠を出している
  onSelect: (nodeId: string) => void;
};

// 受け取った値を描き、クリックは onSelect で通知するだけ（表示専用）。
export function MapNode({ id, data }: NodeProps<Node<MapNodeData, "map">>) {
  return (
    <div
      className={["map-node", data.rejected && "map-node--rejected", data.root && "map-node--root"].filter(Boolean).join(" ")}
      style={{ "--kind-color": data.color } as CSSProperties}
    >
      {data.changedRound !== null && <span key={data.changedRound} className="map-node__flash" aria-hidden="true" />}
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <button type="button" className="map-node__button" aria-pressed={data.selected} onClick={() => data.onSelect(id)}>
        {data.mark && <span className="map-node__mark">{data.mark}</span>}
        <span className="map-node__text">{data.text}</span>
      </button>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}
