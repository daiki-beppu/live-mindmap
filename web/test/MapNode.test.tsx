import type { NodeProps } from "@xyflow/react";
import { describe, expect, it, vi } from "vitest";
import { MapNode, type MapNodeData } from "../src/MapNode.tsx";
import { findAll, textOf } from "./tree.ts";

const data = (extra: Partial<MapNodeData> = {}): MapNodeData => ({
  text: "面接は何回か",
  color: "#eab308",
  mark: "?",
  rejected: false,
  changed: false,
  selected: false,
  onSelect: () => {},
  ...extra,
});

// フックを使わない部品なので、関数として直接呼んで返る要素の木を調べる。
const call = (id: string, d: MapNodeData) => MapNode({ id, data: d } as unknown as NodeProps<never>);

describe("MapNode: ノードのクリック", () => {
  it("ボタンが 1 つあり、クリックすると自分の ID で onSelect を 1 度呼ぶ", () => {
    const onSelect = vi.fn();
    const buttons = findAll(call("n2", data({ onSelect })), "button");
    expect(buttons).toHaveLength(1);
    expect(buttons[0]!.props.type).toBe("button");
    (buttons[0]!.props.onClick as () => void)();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("n2");
  });

  it("選択中かどうかを aria-pressed で伝える", () => {
    const pressed = (selected: boolean) => String(findAll(call("n2", data({ selected })), "button")[0]!.props["aria-pressed"]);
    expect(pressed(true)).toBe("true");
    expect(pressed(false)).toBe("false");
  });

  it("本文と印は、ボタンの中に描く（ボタンの名前になる）", () => {
    const text = textOf(findAll(call("n2", data()), "button")[0]);
    expect(text).toContain("面接は何回か");
    expect(text).toContain("?");
  });
});
