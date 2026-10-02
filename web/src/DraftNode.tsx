import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";

export type DraftNodeData = { text: string };

// 仮のノード（いま話している文字）。本文だけを描く表示専用の部品。種別の色・印・ボタンは持たない。
export function DraftNode({ data }: NodeProps<Node<DraftNodeData, "draft">>) {
  return (
    <div className="draft-node">
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <div className="draft-node__text">{data.text}</div>
    </div>
  );
}
