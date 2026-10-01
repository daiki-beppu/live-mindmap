import type { NodeProps } from "@xyflow/react";
import { describe, expect, it, vi } from "vitest";
import { MapNode, type MapNodeData } from "../src/MapNode.tsx";
import { findAll, textOf } from "./tree.ts";

const data = (extra: Partial<MapNodeData> = {}): MapNodeData => ({
  text: "面接は何回か",
  color: "#eab308",
  mark: "?",
  rejected: false,
  changedRound: null,
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

describe("MapNode: 変わったノードの塗り", () => {
  const flashes = (d: MapNodeData) => findAll(call("n2", d), "span").filter((s) => s.props.className === "map-node__flash");

  it("変わったノードには塗りの層が 1 つあり、読み上げの対象外で、ボタンの外にある", () => {
    const tree = call("n2", data({ changedRound: 3 }));
    const found = flashes(data({ changedRound: 3 }));
    expect(found).toHaveLength(1);
    expect(found[0]!.props["aria-hidden"]).toBe("true");
    expect(findAll(findAll(tree, "button"), "span").filter((s) => s.props.className === "map-node__flash")).toHaveLength(0);
  });

  it("変わっていないノードには塗りの層がない", () => {
    expect(flashes(data({ changedRound: null }))).toHaveLength(0);
  });

  it("赤い枠の class（map-node--changed）は付けない", () => {
    const cls = String((call("n2", data({ changedRound: 3 })) as { props: { className: string } }).props.className);
    expect(cls).not.toContain("map-node--changed");
  });

  it("塗りを足しても、ボタンは 1 つで、文字は本文と印だけ", () => {
    const tree = call("n2", data({ changedRound: 3 }));
    const buttons = findAll(tree, "button");
    expect(buttons).toHaveLength(1);
    expect(textOf(tree)).toBe("?面接は何回か");
  });

  it("反映が変わると塗りの key が変わり（やり直す）、同じ反映が再び届いても変わらない", () => {
    const key = (r: number) => flashes(data({ changedRound: r }))[0]!.key;
    expect(key(2)).not.toBe(key(3));
    expect(key(2)).toBe(key(2));
  });
});

