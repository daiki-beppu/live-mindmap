import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// web の vitest は DOM を持たない。useEffect をその場で実行し、window と KeyboardEvent を最小の代役にする。
let cleanup: (() => void) | undefined;
vi.mock("react", () => ({
  useEffect: (fn: () => (() => void) | void) => {
    cleanup = fn() ?? undefined;
  },
}));

type Listener = (e: unknown) => void;
const listeners: { type: string; fn: Listener; capture: unknown }[] = [];

class FakeKeyboardEvent {
  constructor(type: string, init: Record<string, unknown>) {
    Object.assign(this, { type, ...init });
  }
}

const { useImeKeyRedispatch } = await import("../src/useImeKeyRedispatch.ts");

const keydown = (over: Record<string, unknown>) => {
  const target = { dispatchEvent: vi.fn() };
  const e = {
    key: "",
    code: "",
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    isComposing: false,
    repeat: true,
    location: 0,
    target,
    preventDefault: vi.fn(),
    stopImmediatePropagation: vi.fn(),
    ...over,
  };
  return { e, target };
};

const fire = (e: unknown) => {
  for (const l of listeners.filter((x) => x.type === "keydown")) l.fn(e);
};

beforeEach(() => {
  listeners.length = 0;
  cleanup = undefined;
  vi.stubGlobal("KeyboardEvent", FakeKeyboardEvent);
  vi.stubGlobal("window", {
    addEventListener: (type: string, fn: Listener, capture: unknown) => listeners.push({ type, fn, capture }),
    removeEventListener: (type: string, fn: Listener, capture: unknown) => {
      const i = listeners.findIndex((x) => x.type === type && x.fn === fn && x.capture === capture);
      if (i >= 0) listeners.splice(i, 1);
    },
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("useImeKeyRedispatch", () => {
  it("capture 段階の keydown だけを登録する（keyup は登録しない）", () => {
    useImeKeyRedispatch();
    expect(listeners.map((l) => [l.type, l.capture])).toEqual([["keydown", true]]);
  });

  it("Process のキーを止め、元の target へ非変換中の半角キーを送り直す", () => {
    useImeKeyRedispatch();
    const { e, target } = keydown({ key: "Process", code: "Minus", isComposing: true, metaKey: true });
    fire(e);
    expect(e.preventDefault).toHaveBeenCalledOnce();
    expect(e.stopImmediatePropagation).toHaveBeenCalledOnce();
    expect(target.dispatchEvent).toHaveBeenCalledOnce();
    expect(target.dispatchEvent.mock.calls[0]?.[0]).toMatchObject({
      type: "keydown",
      key: "-",
      code: "Minus",
      metaKey: true,
      repeat: true,
      location: 0,
      bubbles: true,
      cancelable: true,
      composed: true,
    });
    expect(target.dispatchEvent.mock.calls[0]?.[0]).not.toHaveProperty("isComposing", true);
  });

  it("対象外のキー（Escape・変換中でない半角）は止めず、送り直さない", () => {
    useImeKeyRedispatch();
    const hit = keydown({ key: "Process", code: "KeyF", isComposing: true });
    fire(hit.e);
    expect(hit.target.dispatchEvent).toHaveBeenCalledOnce();
    for (const over of [
      { key: "Escape", code: "Escape" },
      { key: "f", code: "KeyF" },
    ]) {
      const { e, target } = keydown(over);
      fire(e);
      expect(e.preventDefault).not.toHaveBeenCalled();
      expect(e.stopImmediatePropagation).not.toHaveBeenCalled();
      expect(target.dispatchEvent).not.toHaveBeenCalled();
    }
  });

  it("unmount の cleanup で解除すると処理されない", () => {
    useImeKeyRedispatch();
    cleanup?.();
    expect(listeners).toHaveLength(0);
    const { e, target } = keydown({ key: "Process", code: "KeyF", isComposing: true });
    fire(e);
    expect(target.dispatchEvent).not.toHaveBeenCalled();
  });
});
