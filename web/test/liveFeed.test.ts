import { describe, expect, it } from "vitest";
import type { Snapshot } from "../../server/src/core/index.ts";
import { applyClose, applyFrame, applyOpen, createFeedState, type FeedState } from "../src/liveFeed.ts";
import { intakeNoticeText } from "../src/intake.ts";
import { spoken, spokenFrame } from "./fixtures/captions.ts";

// Issue #161: frame の分類（type の有無・値）による状態更新と、再接続時の扱い。
// frame の分類と状態の更新の規則（web/src/liveFeed.ts。Foldkit の受信 web/src/app/liveFeed/main.ts の update が使う）を、実コードとして直接検証する（CT-FRAME-DISPATCH）。

const snapshot: Snapshot = { nodes: [{ id: "root", parent: null, kind: "会議", text: "定例", evidence: [] }], round: 0, changes: [], remarks: [] };

describe("applyFrame（frame の分類と状態更新）", () => {
  it("[SCN-U-D-P1] 状態のフレームはスナップショットを上書きしない", () => {
    const state: FeedState = { diffUpdate: null, snapshot, captions: spoken("あ", ""), intake: "running", screenNotice: null, tapNotice: null, local: false, selfPaused: false, speakerNames: {} };
    const next = applyFrame(state, { type: "intake", status: "interrupted" }, 0);
    expect(next.intake).toBe("interrupted");
    expect(next.snapshot).toBe(snapshot);
    expect(next.captions).toEqual(spoken("あ", ""));
  });

  it("[SCN-U-D-N1] type を持たないフレームはスナップショットとして反映される", () => {
    const state: FeedState = { diffUpdate: null, snapshot: null, captions: spoken("", ""), intake: "interrupted", screenNotice: null, tapNotice: null, local: false, selfPaused: false, speakerNames: {} };
    const incoming: Snapshot = { nodes: [{ id: "n1", parent: null, kind: "会議", text: "x", evidence: [] }], round: 1, changes: [], remarks: [] };
    const next = applyFrame(state, incoming, 0);
    expect(next.snapshot).toEqual(incoming);
    expect(next.intake).toBe("interrupted");
  });

  it("[SCN-U-D-P2] 知らない type のフレームは何も変えない", () => {
    const state: FeedState = { diffUpdate: null, snapshot, captions: spoken("あ", "い"), intake: "stopped", screenNotice: null, tapNotice: null, local: false, selfPaused: false, speakerNames: {} };
    // 将来の拡張の type を想定した、知らない type のフレーム（Snapshot | CaptionsFrame | IntakeFrame の型には無い値だが、
    // サーバーが将来送り得る未知の type をブラウザが無視できることを確かめるため、あえて union の外の値を渡す）
    const next = applyFrame(state, { type: "unknown-future" } as unknown as Parameters<typeof applyFrame>[1], 0);
    expect(next).toEqual(state);
  });

  it("[SCN-U-D-N2] captions のフレームは字幕の吹き出しだけを変える", () => {
    const state: FeedState = { diffUpdate: null, snapshot, captions: spoken("", "まえのはつわ"), intake: "running", screenNotice: null, tapNotice: null, local: false, selfPaused: false, speakerNames: {} };
    const next = applyFrame(state, spokenFrame("あ", "相手"), 0);
    expect(next.captions).toEqual(spoken("あ", "")); // フレームは吹き出しの並びの全体なので、前の吹き出しは置き換わる
    expect(next.snapshot).toBe(snapshot);
    expect(next.intake).toBe("running");
  });
});

describe("applyOpen（再接続直後の扱い）", () => {
  it("[SCN-U-A-P1] 再接続しても途切れの一言が途切れない（intake を保つ）", () => {
    const state: FeedState = { diffUpdate: null, snapshot, captions: spoken("のこり", ""), intake: "interrupted", screenNotice: null, tapNotice: null, local: false, selfPaused: false, speakerNames: {} };
    const next = applyOpen(state);
    expect(next.intake).toBe("interrupted"); // 旧コード（intake を既定値へ戻す）だと "running" になり、ここが赤くなる
  });

  it("[SCN-U-A-N1] 再接続は字幕だけを空に戻す", () => {
    const state: FeedState = { diffUpdate: null, snapshot, captions: spoken("のこりのもじ", ""), intake: "running", screenNotice: null, tapNotice: null, local: false, selfPaused: false, speakerNames: {} };
    const next = applyOpen(state);
    expect(next.captions).toEqual(spoken("", ""));
    expect(next.intake).toBe("running");
    expect(next.snapshot).toBe(snapshot);
  });
});

describe("screen-notice（共有画面を使っていないことの一文。Issue #280）", () => {
  it("text を持つフレームは知らせの文だけを変え、スナップショット・字幕・取り込みの状態は変えない", () => {
    const state: FeedState = { diffUpdate: null, snapshot, captions: spoken("あ", "い"), intake: "interrupted", screenNotice: null, tapNotice: null, local: false, selfPaused: false, speakerNames: {} };
    const next = applyFrame(state, { type: "screen-notice", text: "共有画面は使っていません" }, 0);
    expect(next.screenNotice).toBe("共有画面は使っていません");
    expect(next.snapshot).toBe(snapshot);
    expect(next.captions).toEqual(spoken("あ", "い"));
    expect(next.intake).toBe("interrupted");
  });

  it("text が null のフレームで知らせが消える", () => {
    const state: FeedState = { diffUpdate: null, snapshot, captions: spoken("", ""), intake: "running", screenNotice: "共有画面は使っていません", tapNotice: null, local: false, selfPaused: false, speakerNames: {} };
    const next = applyFrame(state, { type: "screen-notice", text: null }, 0);
    expect(next.screenNotice).toBeNull();
    expect(next.snapshot).toBe(snapshot);
    expect(next.intake).toBe("running");
  });

  it("スナップショット・字幕・取り込みのフレームは、出ている知らせを消さない", () => {
    let state: FeedState = { ...createFeedState(), screenNotice: "共有画面は使っていません", tapNotice: null, local: false, selfPaused: false, speakerNames: {} };
    state = applyFrame(state, spokenFrame("あ", "相手"), 0);
    state = applyFrame(state, { type: "intake", status: "interrupted" }, 0);
    state = applyFrame(state, snapshot, 0);
    expect(state.screenNotice).toBe("共有画面は使っていません");
  });

  it("再接続（applyOpen）で、出ていた知らせを null に戻す（切れている間に消すフレームを取りこぼしても古い一文が残らない）", () => {
    const state: FeedState = { diffUpdate: null, snapshot, captions: spoken("のこり", ""), intake: "interrupted", screenNotice: "共有画面は使っていません", tapNotice: null, local: false, selfPaused: false, speakerNames: {} };
    const next = applyOpen(state);
    expect(next.screenNotice).toBeNull();
    expect(next.intake).toBe("interrupted");
    expect(next.snapshot).toBe(snapshot);
  });

  it("同じ状態の上で、知らせ → 再接続 → 保持されていた知らせの再送、と続けて観測できる", () => {
    let state = createFeedState();
    state = applyFrame(state, { type: "screen-notice", text: "共有画面は使っていません" }, 0);
    expect(state.screenNotice).not.toBeNull();
    state = applyOpen(state);
    expect(state.screenNotice).toBeNull();
    state = applyFrame(state, { type: "screen-notice", text: "共有画面は使っていません" }, 0);
    expect(state.screenNotice).toBe("共有画面は使っていません");
  });
});

describe("applyClose（接続が閉じたときの扱い。Issue #280）", () => {
  it("通知を受信した後に接続が閉じ、再接続しない間は、通知が残らない", () => {
    let state = createFeedState();
    state = applyFrame(state, { type: "screen-notice", text: "共有画面は使っていません" }, 0);
    expect(state.screenNotice).toBe("共有画面は使っていません");
    state = applyClose(state);
    expect(state.screenNotice).toBeNull();
  });

  it("スナップショット・字幕・取り込みの状態は変えない", () => {
    const state: FeedState = { diffUpdate: null, snapshot, captions: spoken("のこり", ""), intake: "interrupted", screenNotice: "共有画面は使っていません", tapNotice: null, local: false, selfPaused: false, speakerNames: {} };
    const next = applyClose(state);
    expect(next.snapshot).toBe(snapshot);
    expect(next.captions).toEqual(spoken("のこり", ""));
    expect(next.intake).toBe("interrupted");
  });
});

describe("createFeedState（初期値）", () => {
  it("スナップショットなし・字幕は空・取り込みは running・共有画面の知らせなし（まだフレームを受け取っていないときの既定値）", () => {
    expect(createFeedState()).toEqual({ snapshot: null, captions: spoken("", ""), intake: "running", screenNotice: null, tapNotice: null, diffUpdate: null, local: false, selfPaused: false, speakerNames: {} });
  });
});

// mode 通知は独立した状態。変更前の字幕・マップを保持したまま同じ feed で表示を出し入れする。
describe("ローカルモードの通知", () => {
  it("開始・切断・再接続の再送・終了へ追従し、他の配信状態を変えない", () => {
    let state: FeedState = { ...createFeedState(), snapshot, captions: spoken("字幕", ""), intake: "interrupted" };
    expect(state.local).toBe(false);
    state = applyFrame(state, { type: "session-mode", local: true }, 0);
    expect(state.local).toBe(true);
    expect(state.snapshot).toEqual(snapshot);
    expect(state.captions).toEqual(spoken("字幕", ""));
    expect(state.intake).toBe("interrupted");
    state = applyClose(state);
    expect(state.local).toBe(false);
    state = applyOpen(state);
    state = applyFrame(state, { type: "session-mode", local: true }, 0);
    expect(state.local).toBe(true);
    state = applyFrame(state, { type: "session-mode", local: false }, 0);
    expect(state.local).toBe(false);
    expect(state.snapshot).toEqual(snapshot);
  });
});

// Issue #1069・#1071: 自分の休止。休止中は出し続ける独立した状態で、休止中は frame の理由（手動 / 自動）、再開では false に追従し、つなぎ直しでは false に戻る
describe("applyFrame: self-pause（自分の休止）", () => {
  it("休止の frame で理由になり、休止中に理由だけ変わればその理由に置き換わり、再開の frame で false に戻る（同じ状態の上で連続して観測する）", () => {
    let state: FeedState = createFeedState();
    expect(state.selfPaused).toBe(false);
    state = applyFrame(state, { type: "self-pause", paused: true, reason: "手動" }, 0);
    expect(state.selfPaused).toBe("手動");
    state = applyFrame(state, { type: "self-pause", paused: true, reason: "手動" }, 0);
    expect(state.selfPaused).toBe("手動");
    state = applyFrame(state, { type: "self-pause", paused: true, reason: "自動" }, 0);
    expect(state.selfPaused).toBe("自動");
    state = applyFrame(state, { type: "self-pause", paused: false }, 0);
    expect(state.selfPaused).toBe(false);
  });

  it("スナップショット・字幕・取り込みの状態・各知らせ・モードは変えない", () => {
    const state: FeedState = { diffUpdate: null, snapshot, captions: spoken("あ", "い"), intake: "interrupted", screenNotice: "共有画面は使っていません", tapNotice: "相手の音声が届いていません", local: true, selfPaused: false, speakerNames: {} };
    expect(applyFrame(state, { type: "self-pause", paused: true, reason: "自動" }, 0)).toEqual({ ...state, selfPaused: "自動" });
  });

  it("他の frame は休止の状態に触れない", () => {
    const state: FeedState = { ...createFeedState(), selfPaused: "自動" };
    expect(applyFrame(state, { type: "intake", status: "interrupted" }, 0).selfPaused).toBe("自動");
    expect(applyFrame(state, { type: "tap-notice", text: null }, 0).selfPaused).toBe("自動");
    expect(applyFrame(state, spokenFrame("は", "自分"), 0).selfPaused).toBe("自動");
    expect(applyFrame(state, snapshot, 0).selfPaused).toBe("自動");
  });

  it("つなぎ直し（close・open）で false に戻る。つなぎ直せば server が保持値を送り直す", () => {
    const state: FeedState = { ...createFeedState(), selfPaused: "自動" };
    expect(applyClose(state).selfPaused).toBe(false);
    expect(applyOpen(state).selfPaused).toBe(false);
  });
});

// Issue #161 U-G: 切断中にセッションが終わった場合、再接続したブラウザの一言が無期限に残らないこと。
// applyFrame/applyOpen が作る FeedState の系列と、取り込みの状態から一言を決める規則（intakeNoticeText）で、
// 変化前（途切れの一言が出ている）→ 再接続（applyOpen）→ まだ none を受け取っていない間 → none を受け取った後
// を一続きに観測する（CODING_STANDARDS.md「Negative tests」に従い、守っている状態に到達してから見る）。
// 画面まで届くこと（Foldkit の会議中の画面の上で）は meeting.story.test.ts・meeting.scene.test.ts が見る
describe("再接続からセッション終了までの一言（Issue #161 U-G）", () => {
  const noticeOf = (state: FeedState): string | null => intakeNoticeText({ previous: null, current: state.intake, msSinceChange: 0 });

  it("[SCN-U-G-P2][SCN-U-G-N2] 再接続だけでは一言は消えず、保持されていた {type:\"intake\",status:\"none\"} を受け取ると消える", () => {
    let state: FeedState = createFeedState();

    // 取り込みが途切れ、一言が出ている（守っている状態に先に到達する）
    state = applyFrame(state, { type: "intake", status: "interrupted" }, 0);
    expect(noticeOf(state)).toBe("音声の取り込みが途切れました。再開しています");

    // 接続し直す（applyOpen）。intake は直前の値のまま保たれる
    state = applyOpen(state);
    expect(noticeOf(state)).toBe("音声の取り込みが途切れました。再開しています");

    // [SCN-U-G-N2] まだ取り込みの状態のフレームを 1 件も受け取っていない間は、一言は残り続ける
    expect(noticeOf(state)).toBe("音声の取り込みが途切れました。再開しています");

    // [SCN-U-G-P2] サーバーが保持していた {type:"intake",status:"none"} を受け取ると、一言が無くなる
    state = applyFrame(state, { type: "intake", status: "none" }, 0);
    expect(noticeOf(state)).toBeNull();
  });
});

// Issue #863: 相手の音声が届かない一文。共有画面の一文（screen-notice）とは別の値で、10 秒では消えず、
// 文 → null（新しい origin・stop）のフレームで消える。同じ状態の上で続けて観測する。
describe("applyFrame: tap-notice（相手の音声が届かない一文）", () => {
  const text = "相手の音声が届いていません";

  it("文のフレームで出て、続く null のフレームで消える（同じ状態の上で連続して観測する）", () => {
    let state: FeedState = createFeedState();
    expect(state.tapNotice).toBeNull();
    state = applyFrame(state, { type: "tap-notice", text }, 0);
    expect(state.tapNotice).toBe(text);
    state = applyFrame(state, { type: "tap-notice", text: null }, 0);
    expect(state.tapNotice).toBeNull();
  });

  it("消えた後でも、次の文のフレームでまた出る（起動し直した回でも届かなければ出し直す）", () => {
    let state: FeedState = createFeedState();
    state = applyFrame(state, { type: "tap-notice", text }, 0);
    state = applyFrame(state, { type: "tap-notice", text: null }, 0);
    state = applyFrame(state, { type: "tap-notice", text }, 0);
    expect(state.tapNotice).toBe(text);
  });

  it("共有画面の一文・字幕・取り込みの状態は変えず、共有画面の一文の消去は tap-notice に触れない", () => {
    const state: FeedState = { diffUpdate: null, snapshot, captions: spoken("あ", "い"), intake: "interrupted", screenNotice: "共有画面は使っていません", tapNotice: text, local: false, selfPaused: false, speakerNames: {} };
    const shown = applyFrame(state, { type: "tap-notice", text }, 0);
    expect(shown).toEqual(state);
    const screenCleared = applyFrame(state, { type: "screen-notice", text: null }, 0);
    expect(screenCleared.screenNotice).toBeNull();
    expect(screenCleared.tapNotice).toBe(text);
    const tapCleared = applyFrame(state, { type: "tap-notice", text: null }, 0);
    expect(tapCleared).toEqual({ ...state, tapNotice: null });
  });

  it("つなぎ直し（close・open）で消える。つなぎ直せば server が保持値を送り直す", () => {
    const state: FeedState = { ...createFeedState(), tapNotice: text };
    expect(applyClose(state).tapNotice).toBeNull();
    expect(applyOpen(state).tapNotice).toBeNull();
  });
});

// Issue #1026: 話者の名前のフレーム { type: "speaker-names", names: [{ label, name }] }。サーバーは名前の表の全体を送る。
// web は ラベル → 名前 の表（speakerNames）として持ち、字幕とノードの表示名をそこから毎回導く
describe("applyFrame: speaker-names（話者の名前）", () => {
  const names = (...rows: Array<[string, string]>) => ({ type: "speaker-names" as const, names: rows.map(([label, name]) => ({ label, name })) });

  it("最初は名前の無い表", () => {
    expect(createFeedState().speakerNames).toEqual({});
  });

  it("フレームの名前を ラベル → 名前 の表にする。字幕・スナップショット・取り込みの状態は変えない", () => {
    const state: FeedState = { ...createFeedState(), snapshot, captions: spoken("あ", ""), intake: "interrupted" };

    const next = applyFrame(state, names(["相手 B", "田中"]), 0);

    expect(next.speakerNames).toEqual({ "相手 B": "田中" });
    expect(next.snapshot).toBe(snapshot);
    expect(next.captions).toEqual(spoken("あ", ""));
    expect(next.intake).toBe("interrupted");
  });

  it("フレームは表の全体なので、次のフレームで置き換わる。空の表で全部消える（新しいセッションの始まり）", () => {
    let state = applyFrame(createFeedState(), names(["相手 A", "佐藤"], ["相手 B", "田中"]), 0);
    expect(state.speakerNames).toEqual({ "相手 A": "佐藤", "相手 B": "田中" });

    state = applyFrame(state, names(["相手 B", "鈴木"], ["相手 A", "佐藤"]), 0);
    expect(state.speakerNames).toEqual({ "相手 A": "佐藤", "相手 B": "鈴木" });

    state = applyFrame(state, names(), 0);
    expect(state.speakerNames).toEqual({});
  });

  it("同じ名前を 2 つのラベルに付けても、表は 2 件のまま（まとめない）", () => {
    const next = applyFrame(createFeedState(), names(["相手 A", "田中"], ["相手 B", "田中"]), 0);

    expect(Object.keys(next.speakerNames).sort()).toEqual(["相手 A", "相手 B"]);
  });

  it("接続が閉じても名前は残る。つなぎ直した直後は空に戻り、サーバーの再送で戻る", () => {
    const state = applyFrame(createFeedState(), names(["相手 B", "田中"]), 0);

    expect(applyClose(state).speakerNames).toEqual({ "相手 B": "田中" });
    expect(applyOpen(state).speakerNames).toEqual({});
    expect(applyFrame(applyOpen(state), names(["相手 B", "田中"]), 0).speakerNames).toEqual({ "相手 B": "田中" });
  });
});
