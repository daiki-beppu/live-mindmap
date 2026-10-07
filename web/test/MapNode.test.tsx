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
  fold: null,
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
    (buttons[0]!.props.onClick as (e: unknown) => void)({ currentTarget: {}, clientX: 0, clientY: 0 });
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

describe("MapNode: 変わったノードの点滅", () => {
  const root = (d: MapNodeData) => call("n2", d) as unknown as { key: string | null; props: { className: string } };
  const cls = (d: MapNodeData) => root(d).props.className.split(" ");

  it("変わったノードにだけ map-node--blink が付く", () => {
    expect(cls(data({ changedRound: 3 }))).toContain("map-node--blink");
    expect(cls(data({ changedRound: null }))).not.toContain("map-node--blink");
  });

  it("色の層（塗り）や赤い枠の class は足さない", () => {
    expect(findAll(call("n2", data({ changedRound: 3 })), "span").filter((s) => s.props.className === "map-node__flash")).toHaveLength(0);
    expect(cls(data({ changedRound: 3 }))).not.toContain("map-node--changed");
  });

  it("点滅しても、ボタンは 1 つで、文字は本文と印だけ", () => {
    const tree = call("n2", data({ changedRound: 3 }));
    expect(findAll(tree, "button")).toHaveLength(1);
    expect(textOf(tree)).toBe("?面接は何回か");
  });

  it("反映が変わると key が変わり（点滅をやり直す）、同じ反映が再び届いても変わらない", () => {
    const key = (r: number | null) => root(data({ changedRound: r })).key;
    expect(key(2)).not.toBe(key(3));
    expect(key(2)).toBe(key(2));
    expect(key(null)).not.toBe(key(2));
  });
});

describe("MapNode: ノードの上で始めたドラッグでは、画面を動かさず根拠も出さない", () => {
  const root = (d: MapNodeData) => call("n2", d) as unknown as { props: { className: string } };
  type Handler = (e: unknown) => void;
  const button = (onSelect: () => void) => findAll(call("n2", data({ onSelect })), "button")[0]!.props as { onPointerDown: Handler; onPointerMove: Handler; onPointerUp: Handler; onClick: Handler };
  const at = (target: object, x: number, y: number, pointerId = 7) => ({ target, currentTarget: target, clientX: x, clientY: y, pointerId });
  const capturing = () => ({ setPointerCapture: vi.fn() });

  it("一番外の要素に nopan が付く（React Flow の画面移動の対象から外れる）", () => {
    expect(root(data()).props.className.split(" ")).toContain("nopan");
  });

  it("nowheel は付けない（ノードの上でもスクロールで動く）", () => {
    expect(root(data()).props.className.split(" ")).not.toContain("nowheel");
  });

  it("押した位置から離れた位置での click では、onSelect を呼ばない", () => {
    const onSelect = vi.fn();
    const b = button(onSelect);
    const target = capturing();
    b.onPointerDown(at(target, 100, 100));
    b.onClick(at(target, 160, 140));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("途中でしきい値を超えて動かし、押した位置の近くに戻して離しても、onSelect を呼ばない", () => {
    const onSelect = vi.fn();
    const b = button(onSelect);
    const target = capturing();
    b.onPointerDown(at(target, 100, 100));
    b.onPointerMove(at(target, 160, 100));
    b.onClick(at(target, 101, 100));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("押したとき、ポインタをボタンに固定する（ボタンの外へ出た移動も届く）", () => {
    const b = button(vi.fn());
    const target = capturing();
    b.onPointerDown(at(target, 100, 100, 7));
    expect(target.setPointerCapture).toHaveBeenCalledTimes(1);
    expect(target.setPointerCapture).toHaveBeenCalledWith(7);
  });

  it("しきい値以内の移動だけなら、押した位置の近くでの click で onSelect を呼ぶ", () => {
    const onSelect = vi.fn();
    const b = button(onSelect);
    const target = capturing();
    b.onPointerDown(at(target, 100, 100));
    b.onPointerMove(at(target, 103, 100));
    b.onClick(at(target, 101, 100));
    expect(onSelect).toHaveBeenCalledWith("n2");
  });

  it("同じ位置での click では、onSelect を呼ぶ（対照）", () => {
    const onSelect = vi.fn();
    const b = button(onSelect);
    const target = capturing();
    b.onPointerDown(at(target, 100, 100));
    b.onClick(at(target, 100, 100));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("n2");
  });

  it("押した記録がない click（キーボードでの操作）では、onSelect を呼ぶ", () => {
    const onSelect = vi.fn();
    button(onSelect).onClick(at({}, 0, 0));
    expect(onSelect).toHaveBeenCalledWith("n2");
  });

  it("ドラッグの後の click で記録は使い切られ、次の click は通常どおり onSelect する", () => {
    const onSelect = vi.fn();
    const b = button(onSelect);
    const target = capturing();
    b.onPointerDown(at(target, 0, 0));
    b.onClick(at(target, 90, 90));
    b.onClick(at(target, 90, 90));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("⌘/Ctrl 付きで押して 4px 超動かし、修飾キーなしで離して click しても、onSelect を呼ばない", () => {
    for (const key of ["metaKey", "ctrlKey"]) {
      const onSelect = vi.fn();
      const b = button(onSelect);
      const target = capturing();
      b.onPointerDown({ ...at(target, 100, 100), [key]: true });
      b.onPointerMove(at(target, 110, 100));
      b.onPointerUp(at(target, 110, 100));
      b.onClick(at(target, 110, 100));
      expect(onSelect).not.toHaveBeenCalled();
    }
  });

  it("⌘/Ctrl 付きで押して 4px 超動かし、押した位置の近くへ戻して修飾キーなしで離しても、onSelect を呼ばない", () => {
    for (const key of ["metaKey", "ctrlKey"]) {
      const onSelect = vi.fn();
      const b = button(onSelect);
      const target = capturing();
      b.onPointerDown({ ...at(target, 100, 100), [key]: true });
      b.onPointerMove(at(target, 160, 100));
      b.onPointerUp(at(target, 101, 100));
      b.onClick(at(target, 101, 100));
      expect(onSelect).not.toHaveBeenCalled();
    }
  });

  it("⌘/Ctrl 付きで押して ⌘/Ctrl 付きで離したあとの、キーボードの click では onSelect を呼ぶ", () => {
    for (const key of ["metaKey", "ctrlKey"]) {
      const onSelect = vi.fn();
      const b = button(onSelect);
      const target = capturing();
      b.onPointerDown({ ...at(target, 0, 0), [key]: true });
      b.onPointerUp({ ...at(target, 0, 0), [key]: true });
      b.onClick(at(target, 90, 90));
      expect(onSelect).toHaveBeenCalledTimes(1);
    }
  });

  it("修飾キーなしで押し、⌘/Ctrl を足して離したときも記録を残さない（続く click はマップが止める）。後のキーボードの click では onSelect を呼ぶ", () => {
    for (const key of ["metaKey", "ctrlKey"]) {
      const onSelect = vi.fn();
      const b = button(onSelect);
      const target = capturing();
      b.onPointerDown(at(target, 0, 0));
      b.onPointerUp({ ...at(target, 0, 0), [key]: true });
      b.onClick(at(target, 90, 90));
      expect(onSelect).toHaveBeenCalledTimes(1);
    }
  });
});

describe("MapNode: 畳んだノード", () => {
  const folded = (hint: string | null, hidden: number) => data({ fold: { hint, hidden } });
  const cls = (d: MapNodeData) => (call("n2", d) as unknown as { props: { className: string } }).props.className.split(" ");
  const spans = (d: MapNodeData, name: string) => findAll(call("n2", d), "span").filter((s) => s.props.className === name);

  it("map-node--folded が付く。畳んでいないノードには付かない", () => {
    expect(cls(folded("決定 2・TODO 1", 5))).toContain("map-node--folded");
    expect(cls(data())).not.toContain("map-node--folded");
  });

  it("手がかりの文字を、ボタンの中に本文の後で描く", () => {
    const d = folded("決定 2・TODO 1", 5);
    const text = textOf(findAll(call("n2", d), "button")[0]);
    expect(text).toContain("決定 2・TODO 1");
    expect(text.indexOf("面接は何回か")).toBeLessThan(text.indexOf("決定 2・TODO 1"));
    expect(spans(d, "map-node__hint")).toHaveLength(1);
  });

  it("隠れた数の丸を、ボタンの外に描く", () => {
    const d = folded("決定 2", 5);
    const count = spans(d, "map-node__count");
    expect(count).toHaveLength(1);
    expect(textOf(count[0])).toBe("5");
    expect(textOf(findAll(call("n2", d), "button")[0])).not.toContain("5");
  });

  it("隠れた数が 0 でも丸を描く", () => {
    expect(textOf(spans(folded(null, 0), "map-node__count")[0])).toBe("0");
  });

  it("hint が null なら手がかりの span は描かない", () => {
    expect(spans(folded(null, 3), "map-node__hint")).toHaveLength(0);
  });

  it("fold が null なら、手がかりも丸も描かない", () => {
    expect(spans(data(), "map-node__hint")).toHaveLength(0);
    expect(spans(data(), "map-node__count")).toHaveLength(0);
  });

  it("畳んだノードでも点滅し、ボタンは 1 つのまま", () => {
    const d = data({ fold: { hint: "決定 1", hidden: 2 }, changedRound: 3 });
    expect(cls(d)).toContain("map-node--blink");
    expect(findAll(call("n2", d), "button")).toHaveLength(1);
  });
});
