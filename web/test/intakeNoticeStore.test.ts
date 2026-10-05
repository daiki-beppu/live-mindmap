import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RESUMED_NOTICE_MS } from "../src/intake.ts";
import { createIntakeNoticeStore } from "../src/intakeNoticeStore.ts";

// Issue #161 U-E: 「再開しました」が RESUMED_NOTICE_MS で消えるタイミングを、実タイマーで直接検証する。
// useIntakeNotice.ts の useSyncExternalStore 配線は web にレンダラが無く検証できないが、
// ここで検証するストア自体が、期限切れで実際に listener（再描画の契機）を呼ぶことは直接確かめられる。
describe("createIntakeNoticeStore", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("境界（RESUMED_NOTICE_MS）の内側では「再開しました」を出し続ける", () => {
    const store = createIntakeNoticeStore("interrupted");
    const unsubscribe = store.subscribe(() => {});
    store.setStatus("running");

    expect(store.text()).toBe("再開しました");
    vi.advanceTimersByTime(RESUMED_NOTICE_MS);
    expect(store.text()).toBe("再開しました");

    unsubscribe();
  });

  it("期限切れで listener が呼ばれ、text() が null になる", () => {
    const store = createIntakeNoticeStore("interrupted");
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.setStatus("running");
    listener.mockClear(); // 遷移そのものの通知は対象外にする

    vi.advanceTimersByTime(RESUMED_NOTICE_MS + 1);

    expect(listener).toHaveBeenCalled();
    expect(store.text()).toBeNull();
    unsubscribe();
  });

  it("interrupted のままなら、同じだけ時間が経っても listener は呼ばれず、文も変わらない", () => {
    const store = createIntakeNoticeStore("interrupted");
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    vi.advanceTimersByTime(RESUMED_NOTICE_MS + 1_000);

    expect(listener).not.toHaveBeenCalled();
    expect(store.text()).toBe("音声の取り込みが途切れました。再開しています");
    unsubscribe();
  });

  it("解除した後は、期限が過ぎても listener は呼ばれない（タイマーを残さない）", () => {
    const store = createIntakeNoticeStore("interrupted");
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.setStatus("running");
    unsubscribe();
    listener.mockClear();

    vi.advanceTimersByTime(RESUMED_NOTICE_MS + 1_000);

    expect(listener).not.toHaveBeenCalled();
  });
});
