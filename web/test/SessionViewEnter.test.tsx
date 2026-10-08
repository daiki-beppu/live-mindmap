import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "../../server/src/core/index.ts";

// 登録（キーと option）とコールバックを記録する置き換え。ライブラリの取り消しは option で決まる
type Registration = { hotkey: string; callback: (e: unknown) => void; options: { preventDefault?: boolean } | undefined };
const registrations = vi.hoisted(() => [] as Registration[]);
vi.mock("@tanstack/react-hotkeys", () => ({
  useHotkey: (hotkey: string, callback: (e: unknown) => void, options?: { preventDefault?: boolean }) => {
    registrations.push({ hotkey, callback, options });
  },
}));
const reduceSpy = vi.hoisted(() => vi.fn());
vi.mock("../src/viewing.ts", async (orig) => {
  const actual = await orig<typeof import("../src/viewing.ts")>();
  return { ...actual, reduceViewing: (...args: Parameters<typeof actual.reduceViewing>) => (reduceSpy(...args), actual.reduceViewing(...args)) };
});
vi.mock("../src/useIntakeNotice.ts", () => ({ useIntakeNotice: () => null }));
vi.mock("../src/MapView.tsx", () => ({ MapView: () => <div /> }));
vi.stubGlobal("Element", class {});

const { SessionView } = await import("../src/SessionView.tsx");

const snapshot: Snapshot = { nodes: [{ id: "root", parent: null, kind: "会議", text: "定例", evidence: [] }], round: 1, changes: [], remarks: [] };

const keydown = (target: unknown) => ({ target, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, preventDefault: vi.fn() });
const enterRegistration = () => {
  registrations.length = 0;
  renderToStaticMarkup(<SessionView snapshot={snapshot} speaking={{ 相手: "", 自分: "" }} />);
  const found = registrations.filter((r) => r.hotkey === "Enter");
  expect(found).toHaveLength(1);
  return found[0]!;
};
const elementWith = (match: string) => Object.assign(new (globalThis.Element as unknown as new () => object)(), { closest: (s: string) => (s === match ? {} : null) });

beforeEach(() => {
  registrations.length = 0;
  reduceSpy.mockClear();
});
const enterEvents = () => reduceSpy.mock.calls.filter((c) => (c[1] as { type: string }).type === "enter");

describe("SessionView: Enter の登録", () => {
  it("ライブラリの既定の取り消しを切って登録する", () => {
    expect(enterRegistration().options).toEqual({ preventDefault: false });
  });

  it("フォーカスなし（body）では、従来どおり既定動作を取り消す", () => {
    const e = keydown(elementWith("__none__"));
    enterRegistration().callback(e);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(enterEvents()).toHaveLength(1);
  });

  it("マップ以外のボタンでは、既定動作を取り消さない", () => {
    const e = keydown(elementWith("button, a[href]"));
    enterRegistration().callback(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(enterEvents()).toHaveLength(0);
  });
});
