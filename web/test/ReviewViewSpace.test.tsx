import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// 登録（キーと option）とコールバックを記録する置き換え。ライブラリの取り消しは option で決まる
type Registration = { hotkey: string; callback: (e: unknown) => void; options: { preventDefault?: boolean; enabled?: boolean } | undefined };
const registrations = vi.hoisted(() => [] as Registration[]);
vi.mock("@tanstack/react-hotkeys", () => ({
  useHotkey: (hotkey: string, callback: (e: unknown) => void, options?: Registration["options"]) => {
    registrations.push({ hotkey, callback, options });
  },
}));
const reducerSpy = vi.hoisted(() => vi.fn());
vi.mock("../src/reviewPlayback.ts", async (orig) => {
  const actual = await orig<typeof import("../src/reviewPlayback.ts")>();
  return { ...actual, playbackReducer: (...args: Parameters<typeof actual.playbackReducer>) => (reducerSpy(...args), actual.playbackReducer(...args)) };
});
vi.mock("../src/SessionView.tsx", () => ({ SessionView: () => null }));
vi.mock("../src/ReviewControls.tsx", () => ({ ReviewControls: () => null }));

const { ReviewView } = await import("../src/ReviewView.tsx");

const keydown = (target: unknown) => ({ target, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, preventDefault: vi.fn() });
const registration = (hotkey: string) => {
  registrations.length = 0;
  renderToStaticMarkup(<ReviewView events={[{ at: "2099-12-31T23:59:59.000Z", type: "start", title: "定例" }]} />);
  const found = registrations.filter((r) => r.hotkey === hotkey);
  expect(found).toHaveLength(1);
  return found[0]!;
};
// 祖先に match（完全一致のセレクタではなく、含まれるクラス名）があれば見つかる代役
const elementWith = (...classes: string[]) => ({ closest: (s: string) => (classes.some((c) => s.includes(c)) ? {} : null) });
const toggles = () => reducerSpy.mock.calls.filter((c) => (c[1] as { type: string }).type === "toggle");

beforeEach(() => {
  registrations.length = 0;
  reducerSpy.mockClear();
});

describe("ReviewView: Space の登録", () => {
  it("ライブラリの既定の取り消しを切って登録する（丸のボタンの click を残すため）", () => {
    expect(registration("Space").options?.preventDefault).toBe(false);
  });

  it.each(["map-node__count--pressable", "map-node__fold-dot"])("%s の中にフォーカスがあれば、再生を切り替えず、既定動作も取り消さない", (cls) => {
    const e = keydown(elementWith(cls));
    registration("Space").callback(e);
    expect(toggles()).toHaveLength(0);
    expect(e.preventDefault).not.toHaveBeenCalled();
  });

  it("ノード本体のボタンなど、丸以外では、今までどおり既定動作を取り消して再生を切り替える", () => {
    const e = keydown(elementWith("map-node__button"));
    registration("Space").callback(e);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(toggles()).toHaveLength(1);
  });

  it("フォーカスなし（body）でも、今までどおり既定動作を取り消して再生を切り替える", () => {
    const e = keydown(elementWith());
    registration("Space").callback(e);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(toggles()).toHaveLength(1);
  });
});

describe("ReviewView: Space 以外のキーの登録は今のまま", () => {
  it("K は option を付けず、丸の中でも再生を切り替える", () => {
    const k = registration("K");
    expect(k.options?.preventDefault).toBeUndefined();
    k.callback(keydown(elementWith("map-node__fold-dot")));
    expect(toggles()).toHaveLength(1);
  });
});
