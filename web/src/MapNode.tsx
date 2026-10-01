import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { CSSProperties } from "react";

export type MapNodeData = {
  text: string;
  color: string;
  mark: string | null;
  rejected: boolean;
  changed: boolean; // 今回の反映で変わった（赤い枠）
  selected: boolean; // 右の列に根拠を出している
  onSelect: (nodeId: string) => void;
};

// 受け取った値を描き、クリックは onSelect で通知するだけ（表示専用）。
export function MapNode({ id, data }: NodeProps<Node<MapNodeData, "map">>) {
  return (
    <div
      className={["map-node", data.rejected && "map-node--rejected", data.changed && "map-node--changed"].filter(Boolean).join(" ")}
      style={{ "--kind-color": data.color } as CSSProperties}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <button type="button" className="map-node__button" aria-pressed={data.selected} onClick={() => data.onSelect(id)}>
        {data.mark && <span className="map-node__mark">{data.mark}</span>}
        <span className="map-node__text">{data.text}</span>
      </button>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}
