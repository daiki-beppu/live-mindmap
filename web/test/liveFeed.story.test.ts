import { Option } from "effect";
import { given, message, model, story } from "foldkit/story";
import { describe, expect, it } from "vitest";
import type { Snapshot } from "../../server/src/core/index.ts";
import { init, update, type Model } from "../src/app/liveFeed/main.ts";
import { Message } from "../src/app/liveFeed/message.ts";

// ライブの受信（Issue #828）の update。「つながった」「frame を受けた」「切れた」の事実の Message の列を、同じ Model の上に続けて流し、
// 今の useLiveFeed.test.ts と liveFeed.test.ts が見ている値（受信・切断・つなぎ直し・つないだときに server が先に送る値）を確かめる。
// 状態の更新の規則は web/src/liveFeed.ts（applyFrame / applyOpen / applyClose）が持つ。ここでは update がそれを使っていることを、結果の Model で見る。

const NOTICE = "共有画面は使っていません";
const TAP_NOTICE = "相手の音声が届いていません";

const node = (id: string, parent: string | null) => ({ id, parent, kind: parent === null ? ("会議" as const) : ("議題" as const), text: id, evidence: parent ? ["r1"] : [] });
const snapshot: Snapshot = { nodes: [node("root", null), node("A", "root")], round: 3, changes: [], remarks: [] };

const received = (frame: typeof Message.ReceivedLiveFrame.Type["frame"]) => message(Message.ReceivedLiveFrame({ frame }));
const connected = () => message(Message.ConnectedLiveFeed());
const disconnected = () => message(Message.DisconnectedLiveFeed());

describe("初期値", () => {
  it("まだ何も受けていない: スナップショット・知らせ・差分更新は None、字幕は空、取り込みは動いている、モード表示は出ない", () => {
    expect(init()).toEqual({
      snapshot: Option.none(),
      speaking: { 相手: "", 自分: "" },
      intake: "running",
      screenNotice: Option.none(),
      tapNotice: Option.none(),
      diffUpdate: Option.none(),
      local: false,
    } satisfies Model);
  });
});

describe("受信（frame を受けた）", () => {
  it("スナップショットを受けると Some で持つ。知らせは変わらない", () => {
    story(
      update,
      given(init()),
      received({ type: "screen-notice", text: NOTICE }),
      received(snapshot),
      model((m) => {
        expect(m.snapshot).toEqual(Option.some(snapshot));
        expect(m.screenNotice).toEqual(Option.some(NOTICE));
      }),
    );
  });

  it("共有画面の一文と取り込みの状態を続けて受けると、知らせは Some、取り込みは interrupted。スナップショットは変えない", () => {
    story(
      update,
      given(init()),
      received(snapshot),
      received({ type: "screen-notice", text: NOTICE }),
      received({ type: "intake", status: "interrupted" }),
      model((m) => {
        expect(m.screenNotice).toEqual(Option.some(NOTICE));
        expect(m.intake).toBe("interrupted");
        expect(m.snapshot).toEqual(Option.some(snapshot));
      }),
    );
  });

  it("字幕はトラックごと。片方を受けても、もう片方は変わらない", () => {
    story(
      update,
      given(init()),
      received({ type: "speaking", track: "相手", text: "こんにち" }),
      received({ type: "speaking", track: "自分", text: "はい" }),
      received({ type: "speaking", track: "相手", text: "こんにちは" }),
      model((m) => expect(m.speaking).toEqual({ 相手: "こんにちは", 自分: "はい" })),
    );
  });

  it("text や state が null の frame は、None に戻す（Model に null を持たない）", () => {
    story(
      update,
      given(init()),
      received({ type: "screen-notice", text: NOTICE }),
      received({ type: "tap-notice", text: TAP_NOTICE }),
      received({ type: "diff-update", state: { status: "running" } }),
      model((m) => {
        expect(m.screenNotice).toEqual(Option.some(NOTICE));
        expect(m.tapNotice).toEqual(Option.some(TAP_NOTICE));
        expect(m.diffUpdate).toEqual(Option.some({ status: "running" }));
      }),
      received({ type: "screen-notice", text: null }),
      received({ type: "tap-notice", text: null }),
      received({ type: "diff-update", state: null }),
      model((m) => {
        expect(m.screenNotice).toEqual(Option.none());
        expect(m.tapNotice).toEqual(Option.none());
        expect(m.diffUpdate).toEqual(Option.none());
      }),
    );
  });
});

describe("切れた", () => {
  it("共有画面の一文・相手の音声の知らせ・モード表示を消す。スナップショット・字幕・取り込みの状態・差分更新は保つ", () => {
    story(
      update,
      given(init()),
      received(snapshot),
      received({ type: "speaking", track: "相手", text: "こんにち" }),
      received({ type: "intake", status: "interrupted" }),
      received({ type: "screen-notice", text: NOTICE }),
      received({ type: "tap-notice", text: TAP_NOTICE }),
      received({ type: "diff-update", state: { status: "restarting" } }),
      received({ type: "session-mode", local: true }),
      disconnected(),
      model((m) => {
        expect(m.screenNotice).toEqual(Option.none());
        expect(m.tapNotice).toEqual(Option.none());
        expect(m.local).toBe(false);
        expect(m.snapshot).toEqual(Option.some(snapshot));
        expect(m.speaking).toEqual({ 相手: "こんにち", 自分: "" });
        expect(m.intake).toBe("interrupted");
        expect(m.diffUpdate).toEqual(Option.some({ status: "restarting" }));
      }),
    );
  });
});

describe("つなぎ直した（切れた後に、つながった）", () => {
  it("字幕・知らせ・モード表示を戻す。取り込みの状態とスナップショットは保ち、「動いている」を捏造しない（Issue #161 U-A）", () => {
    story(
      update,
      given(init()),
      received(snapshot),
      received({ type: "speaking", track: "自分", text: "はい" }),
      received({ type: "intake", status: "stopped" }),
      received({ type: "screen-notice", text: NOTICE }),
      received({ type: "session-mode", local: true }),
      disconnected(),
      connected(),
      model((m) => {
        expect(m.speaking).toEqual({ 相手: "", 自分: "" });
        expect(m.screenNotice).toEqual(Option.none());
        expect(m.tapNotice).toEqual(Option.none());
        expect(m.local).toBe(false);
        expect(m.intake).toBe("stopped");
        expect(m.snapshot).toEqual(Option.some(snapshot));
      }),
    );
  });

  it("同じ Model が、切れる・つなぎ直すを繰り返しても、そのつど最新の値に追従する", () => {
    story(
      update,
      given(init()),
      connected(),
      received({ type: "screen-notice", text: NOTICE }),
      disconnected(),
      connected(),
      received({ type: "screen-notice", text: "別の一文" }),
      received({ type: "intake", status: "interrupted" }),
      disconnected(),
      connected(),
      model((m) => {
        expect(m.screenNotice).toEqual(Option.none());
        expect(m.intake).toBe("interrupted");
      }),
      received({ type: "intake", status: "running" }),
      model((m) => expect(m.intake).toBe("running")),
    );
  });
});

describe("つないだときの値（server が、つないだら保持している値を先に送る）", () => {
  it("つながった後に、server が先に送る値（スナップショット・取り込み・共有画面の一文・相手の音声の知らせ・差分更新・モード表示）を受けると、Model がその値になる", () => {
    story(
      update,
      given(init()),
      connected(),
      received(snapshot),
      received({ type: "intake", status: "interrupted" }),
      received({ type: "screen-notice", text: NOTICE }),
      received({ type: "tap-notice", text: TAP_NOTICE }),
      received({ type: "diff-update", state: { status: "paused", reason: "ChatGPT の利用上限" } }),
      received({ type: "session-mode", local: true }),
      model((m) => {
        expect(m).toEqual({
          snapshot: Option.some(snapshot),
          speaking: { 相手: "", 自分: "" },
          intake: "interrupted",
          screenNotice: Option.some(NOTICE),
          tapNotice: Option.some(TAP_NOTICE),
          diffUpdate: Option.some({ status: "paused", reason: "ChatGPT の利用上限" }),
          local: true,
        } satisfies Model);
      }),
    );
  });

  it("つなぎ直したときも、先に送られた値で置き換わる（古いスナップショットと取り込みの状態を上書きする）", () => {
    const newer: Snapshot = { ...snapshot, round: 4 };
    story(
      update,
      given(init()),
      received(snapshot),
      received({ type: "intake", status: "interrupted" }),
      disconnected(),
      connected(),
      received(newer),
      received({ type: "intake", status: "running" }),
      received({ type: "session-mode", local: true }),
      model((m) => {
        expect(m.snapshot).toEqual(Option.some(newer));
        expect(m.intake).toBe("running");
        expect(m.local).toBe(true);
      }),
    );
  });
});
