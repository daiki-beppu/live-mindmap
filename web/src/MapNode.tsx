import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import type { CSSProperties } from "react";

export type MapNodeData = {
  text: string;
  color: string;
  mark: string | null;
  rejected: boolean;
};

// 受け取った値を描くだけ（表示専用）。
export function MapNode({ data }: NodeProps<Node<MapNodeData, "map">>) {
  return (
    <div
      className={data.rejected ? "map-node map-node--rejected" : "map-node"}
      style={{ "--kind-color": data.color } as CSSProperties}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} />
      {data.mark && <span className="map-node__mark">{data.mark}</span>}
      <span className="map-node__text">{data.text}</span>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
}
