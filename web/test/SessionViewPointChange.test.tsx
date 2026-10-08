import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "../../server/src/core/index.ts";

vi.mock("@tanstack/react-hotkeys", () => ({ useHotkey: () => {} }));
const reduceSpy = vi.hoisted(() => vi.fn());
vi.mock("../src/viewing.ts", async (orig) => {
  const actual = await orig<typeof import("../src/viewing.ts")>();
  return { ...actual, reduceViewing: (...args: Parameters<typeof actual.reduceViewing>) => (reduceSpy(...args), actual.reduceViewing(...args)) };
});
// 「変わったこと」の項目から渡される onSelect を取り出す置き換え
const listProps = vi.hoisted(() => ({ current: undefined as { onSelect: (id: string) => void } | undefined }));
vi.mock("../src/ChangeList.tsx", () => ({
  ChangeList: (props: { onSelect: (id: string) => void }) => {
    listProps.current = props;
    return <div />;
  },
}));
vi.mock("../src/useIntakeNotice.ts", () => ({ useIntakeNotice: () => null }));
vi.mock("../src/MapView.tsx", () => ({ MapView: () => <div /> }));
vi.stubGlobal("Element", class {});

const { SessionView } = await import("../src/SessionView.tsx");

// root ─ A（済み）─ A1 / B（話し中）
const snapshot: Snapshot = {
  nodes: [
    { id: "root", parent: null, kind: "会議", text: "定例", evidence: [] },
    { id: "A", parent: "root", kind: "議題", text: "A", evidence: ["r1"], talkStatus: "済み" },
    { id: "A1", parent: "A", kind: "論点", text: "A1", evidence: ["r1"] },
    { id: "B", parent: "root", kind: "議題", text: "B", evidence: ["r1"] },
  ],
  round: 1,
  changes: [],
  remarks: [],
  currentTopic: "B",
  now: 10,
};

const point = (id: string) => {
  reduceSpy.mockClear();
  listProps.current = undefined;
  renderToStaticMarkup(<SessionView snapshot={snapshot} speaking={{ 相手: "", 自分: "" }} />);
  listProps.current!.onSelect(id);
  return reduceSpy.mock.calls.map((c) => c[1] as { type: string; id?: string; ancestors?: string[]; open?: boolean });
};

beforeEach(() => {
  reduceSpy.mockClear();
});

describe("SessionView: 「変わったこと」の項目から指す", () => {
  it("スナップショットにある畳んだ議題 A を指すと、select ではなく pointChange が届く（祖先と、開くかを入れて）", () => {
    const events = point("A");
    expect(events.map((e) => e.type)).toEqual(["pointChange"]);
    expect(events[0]).toMatchObject({ id: "A", open: true });
    expect(events[0]!.ancestors).toEqual(["root"]);
  });

  it("畳んだ議題の中に隠れたノード A1 を指すと、祖先に root と A が入る", () => {
    const events = point("A1");
    expect(events.map((e) => e.type)).toEqual(["pointChange"]);
    expect([...events[0]!.ancestors!].sort()).toEqual(["A", "root"]);
  });

  it("スナップショットに無いノードを指すと、今までの select が届く（カメラを動かさない）", () => {
    const events = point("gone");
    expect(events).toEqual([{ type: "select", id: "gone" }]);
  });
});
