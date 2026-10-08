import { describe, expect, it } from "vitest";
import type { Snapshot } from "../../server/src/core/index.ts";
import { applyClose, applyFrame, applyOpen, createFeedState, type FeedState } from "../src/liveFeed.ts";
import { createIntakeNoticeStore } from "../src/intakeNoticeStore.ts";

// Issue #161: frame の分類（type の有無・値）による状態更新と、再接続時の扱い。
// useLiveFeed.ts の useEffect 内クロージャ（DOM・レンダラが無い web のテスト環境では到達できない）から
// 分岐を抜き出した純粋モジュールを、実コードとして直接検証する（CT-FRAME-DISPATCH）。

const snapshot: Snapshot = { nodes: [{ id: "root", parent: null, kind: "会議", text: "定例", evidence: [] }], round: 0, changes: [], remarks: [] };

describe("applyFrame（frame の分類と状態更新）", () => {
  it("[SCN-U-D-P1] 状態のフレームはスナップショットを上書きしない", () => {
    const state: FeedState = { snapshot, speaking: { 相手: "あ", 自分: "" }, intake: "running", screenNotice: null };
    const next = applyFrame(state, { type: "intake", status: "interrupted" });
    expect(next.intake).toBe("interrupted");
    expect(next.snapshot).toBe(snapshot);
    expect(next.speaking).toEqual({ 相手: "あ", 自分: "" });
  });

  it("[SCN-U-D-N1] type を持たないフレームはスナップショットとして反映される", () => {
    const state: FeedState = { snapshot: null, speaking: { 相手: "", 自分: "" }, intake: "interrupted", screenNotice: null };
    const incoming: Snapshot = { nodes: [{ id: "n1", parent: null, kind: "会議", text: "x", evidence: [] }], round: 1, changes: [], remarks: [] };
    const next = applyFrame(state, incoming);
    expect(next.snapshot).toEqual(incoming);
    expect(next.intake).toBe("interrupted");
  });

  it("[SCN-U-D-P2] 知らない type のフレームは何も変えない", () => {
    const state: FeedState = { snapshot, speaking: { 相手: "あ", 自分: "い" }, intake: "stopped", screenNotice: null };
    // 将来の拡張の type を想定した、知らない type のフレーム（Snapshot | SpeakingFrame | IntakeFrame の型には無い値だが、
    // サーバーが将来送り得る未知の type をブラウザが無視できることを確かめるため、あえて union の外の値を渡す）
    const next = applyFrame(state, { type: "unknown-future" } as unknown as Parameters<typeof applyFrame>[1]);
    expect(next).toEqual(state);
  });

  it("[SCN-U-D-N2] speaking のフレームはトラックの文字だけを変える", () => {
    const state: FeedState = { snapshot, speaking: { 相手: "", 自分: "まえのはつわ" }, intake: "running", screenNotice: null };
    const next = applyFrame(state, { type: "speaking", track: "相手", text: "あ" });
    expect(next.speaking).toEqual({ 相手: "あ", 自分: "まえのはつわ" });
    expect(next.snapshot).toBe(snapshot);
    expect(next.intake).toBe("running");
  });
});

describe("applyOpen（再接続直後の扱い）", () => {
  it("[SCN-U-A-P1] 再接続しても途切れの一言が途切れない（intake を保つ）", () => {
    const state: FeedState = { snapshot, speaking: { 相手: "のこり", 自分: "" }, intake: "interrupted", screenNotice: null };
    const next = applyOpen(state);
    expect(next.intake).toBe("interrupted"); // 旧コード（intake を既定値へ戻す）だと "running" になり、ここが赤くなる
  });

  it("[SCN-U-A-N1] 再接続は字幕だけを空に戻す", () => {
    const state: FeedState = { snapshot, speaking: { 相手: "のこりのもじ", 自分: "" }, intake: "running", screenNotice: null };
    const next = applyOpen(state);
    expect(next.speaking).toEqual({ 相手: "", 自分: "" });
    expect(next.intake).toBe("running");
    expect(next.snapshot).toBe(snapshot);
  });
});

describe("screen-notice（共有画面を使っていないことの一文。Issue #280）", () => {
  it("text を持つフレームは知らせの文だけを変え、スナップショット・字幕・取り込みの状態は変えない", () => {
    const state: FeedState = { snapshot, speaking: { 相手: "あ", 自分: "い" }, intake: "interrupted", screenNotice: null };
    const next = applyFrame(state, { type: "screen-notice", text: "共有画面は使っていません" });
    expect(next.screenNotice).toBe("共有画面は使っていません");
    expect(next.snapshot).toBe(snapshot);
    expect(next.speaking).toEqual({ 相手: "あ", 自分: "い" });
    expect(next.intake).toBe("interrupted");
  });

  it("text が null のフレームで知らせが消える", () => {
    const state: FeedState = { snapshot, speaking: { 相手: "", 自分: "" }, intake: "running", screenNotice: "共有画面は使っていません" };
    const next = applyFrame(state, { type: "screen-notice", text: null });
    expect(next.screenNotice).toBeNull();
    expect(next.snapshot).toBe(snapshot);
    expect(next.intake).toBe("running");
  });

  it("スナップショット・字幕・取り込みのフレームは、出ている知らせを消さない", () => {
    let state: FeedState = { ...createFeedState(), screenNotice: "共有画面は使っていません" };
    state = applyFrame(state, { type: "speaking", track: "相手", text: "あ" });
    state = applyFrame(state, { type: "intake", status: "interrupted" });
    state = applyFrame(state, snapshot);
    expect(state.screenNotice).toBe("共有画面は使っていません");
  });

  it("再接続（applyOpen）で、出ていた知らせを null に戻す（切れている間に消すフレームを取りこぼしても古い一文が残らない）", () => {
    const state: FeedState = { snapshot, speaking: { 相手: "のこり", 自分: "" }, intake: "interrupted", screenNotice: "共有画面は使っていません" };
    const next = applyOpen(state);
    expect(next.screenNotice).toBeNull();
    expect(next.intake).toBe("interrupted");
    expect(next.snapshot).toBe(snapshot);
  });

  it("同じ状態の上で、知らせ → 再接続 → 保持されていた知らせの再送、と続けて観測できる", () => {
    let state = createFeedState();
    state = applyFrame(state, { type: "screen-notice", text: "共有画面は使っていません" });
    expect(state.screenNotice).not.toBeNull();
    state = applyOpen(state);
    expect(state.screenNotice).toBeNull();
    state = applyFrame(state, { type: "screen-notice", text: "共有画面は使っていません" });
    expect(state.screenNotice).toBe("共有画面は使っていません");
  });
});

describe("applyClose（接続が閉じたときの扱い。Issue #280）", () => {
  it("通知を受信した後に接続が閉じ、再接続しない間は、通知が残らない", () => {
    let state = createFeedState();
    state = applyFrame(state, { type: "screen-notice", text: "共有画面は使っていません" });
    expect(state.screenNotice).toBe("共有画面は使っていません");
    state = applyClose(state);
    expect(state.screenNotice).toBeNull();
  });

  it("スナップショット・字幕・取り込みの状態は変えない", () => {
    const state: FeedState = { snapshot, speaking: { 相手: "のこり", 自分: "" }, intake: "interrupted", screenNotice: "共有画面は使っていません" };
    const next = applyClose(state);
    expect(next.snapshot).toBe(snapshot);
    expect(next.speaking).toEqual({ 相手: "のこり", 自分: "" });
    expect(next.intake).toBe("interrupted");
  });
});

describe("createFeedState（初期値）", () => {
  it("スナップショットなし・字幕は空・取り込みは running・共有画面の知らせなし（まだフレームを受け取っていないときの既定値）", () => {
    expect(createFeedState()).toEqual({ snapshot: null, speaking: { 相手: "", 自分: "" }, intake: "running", screenNotice: null });
  });
});

// Issue #161 U-G: 切断中にセッションが終わった場合、再接続したブラウザの一言が無期限に残らないこと。
// applyFrame/applyOpen が作る FeedState の系列と、同じ intakeNoticeStore の実体で、
// 変化前（途切れの一言が出ている）→ 再接続（applyOpen）→ まだ none を受け取っていない間 → none を受け取った後
// を一続きに観測する（CODING_STANDARDS.md「Negative tests」に従い、守っている状態に到達してから見る）
describe("再接続からセッション終了までの一言（Issue #161 U-G）", () => {
  it("[SCN-U-G-P2][SCN-U-G-N2] 再接続だけでは一言は消えず、保持されていた {type:\"intake\",status:\"none\"} を受け取ると消える", () => {
    const store = createIntakeNoticeStore("running");
    let state: FeedState = createFeedState();

    // 取り込みが途切れ、一言が出ている（守っている状態に先に到達する）
    state = applyFrame(state, { type: "intake", status: "interrupted" });
    store.setStatus(state.intake);
    expect(store.text()).toBe("音声の取り込みが途切れました。再開しています");

    // 接続し直す（applyOpen）。intake は直前の値のまま保たれる
    state = applyOpen(state);
    store.setStatus(state.intake);
    expect(store.text()).toBe("音声の取り込みが途切れました。再開しています");

    // [SCN-U-G-N2] まだ取り込みの状態のフレームを 1 件も受け取っていない間は、一言は残り続ける
    expect(store.text()).toBe("音声の取り込みが途切れました。再開しています");

    // [SCN-U-G-P2] サーバーが保持していた {type:"intake",status:"none"} を受け取ると、一言が無くなる
    state = applyFrame(state, { type: "intake", status: "none" });
    store.setStatus(state.intake);
    expect(store.text()).toBeNull();
  });
});
