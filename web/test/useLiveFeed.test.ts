import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeedState } from "../src/liveFeed.ts";

// web の vitest は DOM を持たない。useState / useEffect をその場で動かし、WebSocket と location を最小の代役にして、
// useLiveFeed の onclose の配線（切断時に共有画面の一文を消す。Issue #280）を実際のフックで観測する。
let current: FeedState;
let cleanup: (() => void) | undefined;
vi.mock("react", () => ({
  useState: (init: () => FeedState) => {
    current = init();
    const set = (u: FeedState | ((p: FeedState) => FeedState)) => {
      current = typeof u === "function" ? u(current) : u;
    };
    return [current, set];
  },
  useEffect: (fn: () => (() => void) | void) => {
    cleanup = fn() ?? undefined;
  },
}));

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  close = vi.fn();
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
}

const { useLiveFeed } = await import("../src/useLiveFeed.ts");
const NOTICE = "共有画面は使っていません";

beforeEach(() => {
  FakeWebSocket.instances = [];
  cleanup = undefined;
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("location", { protocol: "http:", host: "localhost:1" });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("useLiveFeed の onclose（切断時の共有画面の一文）", () => {
  it("通知を受信した後に接続が閉じると、再接続の前に通知が消える。字幕・取り込みの状態は保たれる", () => {
    useLiveFeed();
    const ws = FakeWebSocket.instances[0]!;
    ws.onmessage!({ data: JSON.stringify({ type: "screen-notice", text: NOTICE }) });
    ws.onmessage!({ data: JSON.stringify({ type: "intake", status: "interrupted" }) });
    expect(current.screenNotice).toBe(NOTICE);

    ws.onclose!();

    expect(current.screenNotice).toBeNull();
    expect(current.intake).toBe("interrupted");
    expect(FakeWebSocket.instances).toHaveLength(1); // まだ再接続していない
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("アンマウントで閉じたときは、状態を更新せず再接続も予約しない", () => {
    useLiveFeed();
    const ws = FakeWebSocket.instances[0]!;
    ws.onmessage!({ data: JSON.stringify({ type: "screen-notice", text: NOTICE }) });

    cleanup!();
    ws.onclose!();

    expect(current.screenNotice).toBe(NOTICE);
    vi.advanceTimersByTime(5000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
