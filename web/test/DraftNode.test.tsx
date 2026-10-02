import type { NodeProps } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { DraftNode } from "../src/DraftNode.tsx";
import { findAll, textOf } from "./tree.ts";

// フックを使わない表示専用の部品なので、関数として直接呼んで返る要素の木を調べる。
const call = (text: string) => DraftNode({ id: "draft:相手", data: { text } } as unknown as NodeProps<never>) as unknown as { props: { className: string; style?: Record<string, unknown> } };

describe("DraftNode: 仮のノード", () => {
  it("渡された文字を描く", () => {
    expect(textOf(call("いま話している文字") as never)).toBe("いま話している文字");
  });

  it("操作できない（ボタンを持たない）。種別の色・印も持たない", () => {
    const tree = call("あ");
    expect(findAll(tree as never, "button")).toHaveLength(0);
    expect(tree.props.style?.["--kind-color"]).toBeUndefined();
  });

  it("正式なノードの class は使わず、仮のノード専用の class で描く（見た目は styles.css が分ける）", () => {
    const classes = call("あ").props.className.split(" ");
    expect(classes).toContain("draft-node");
    expect(classes.some((c) => c.startsWith("map-node"))).toBe(false);
  });
});
