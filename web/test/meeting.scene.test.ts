import * as Popover from "@foldkit/ui/popover";
import { click, expect as expectScene, findAll, Mount, selector, submit, tap, type as typeInto } from "foldkit/scene";
import { describe, expect, it } from "vitest";
import type { CaptionBubble, Snapshot } from "../../server/src/core/index.ts";
import { keyListRows, type KeyId } from "../src/app/keys/table.ts";
import { Message as MapSurfaceMessage } from "../src/app/mapSurface/message.ts";
import {
  commandNames,
  connected,
  DIFF,
  disconnected,
  expire,
  FIRST,
  frame,
  frameRaw,
  HEIGHTS,
  init,
  INTERRUPTED,
  intake,
  layoutOutline,
  MANUAL,
  matchesReference,
  meetingScene,
  OVERVIEW,
  PAUSED,
  PAUSED_TEXT,
  press,
  referenceOf,
  referencePress,
  raw,
  referenceUpdate,
  RESUMED,
  SCREEN,
  SELF_PAUSE_TEXT,
  selfPause,
  selfPauseRequests,
  SELF_PAUSE_AUTO_TEXT,
  SECOND,
  selectedIds,
  settle,
  settleCommands,
  speakerNameRequests,
  shapeOf,
  speak,
  STOPPED,
  surface,
  TAP,
  texts,
  THIRD_QUIET,
  timers,
  viewportOf,
  type MeetingMessage,
  type Model,
  type Sim,
} from "./meetingHarness.ts";
import { spokenBubble, spokenFrame } from "./fixtures/captions.ts";
import { one, renderedIds } from "./sceneTree.ts";

// 会議中の Foldkit プログラム（Issue #829）の Scene。描いた view から入り、`/ws` の frame（描いた木の外から届くので Subscription.emit で流す）が、
// 最初のスナップショットまでの待ち表示・画面の並び・知らせ・字幕・マップ・右の列・キーまで届くことを、同じ画面（1 つの Model）の上の続きで見る。
// 並び・class・文言は React の SessionView（.layout の直下: ローカルモード → .map → 字幕 → 取り込み → 共有画面 → 相手の音声 → 差分更新 → .side）と同じ。
// マップの動き（ビューポート・選択・補間）は、live の表示面（MapSurface）に同じ Message を流した結果と、描いた木が一致することで見る（動きの中身は mapSurface の Story・Scene が見る）。

const WAITING = "サーバーを待っています";
const NOTICE_CLASSES = ["intake-notice", "screen-notice", "tap-notice", "diff-update-notice", "self-pause-notice", "local-mode-notice", "local-mode-line"];

const expectOnlyWaiting = (sim: Sim) => {
  expect(texts(sim.html, "p.waiting")).toEqual([WAITING]);
  for (const css of [".layout", ".map", ".map-surface", ".captions", ".side", ".viewing-notice", ...NOTICE_CLASSES.map((c) => `.${c}`)]) {
    expect(findAll(sim.html, css), css).toHaveLength(0);
  }
};
const noticeTextOf = (reference: { viewing: { mode: string } }): string[] => (reference.viewing.mode === "manual" ? [MANUAL] : reference.viewing.mode === "overview" ? [OVERVIEW] : reference.viewing.mode === "diff" ? [DIFF] : []);

describe("会議中の Scene: 待ち表示（最初のスナップショットまで）", () => {
  it("起動直後は『サーバーを待っています』だけが出て、マップ・字幕・知らせ・右の列は描かない", () => {
    meetingScene(init(false), tap(expectOnlyWaiting));
  });

  it("スナップショット以外の frame（字幕・取り込み・共有画面・相手の音声・差分更新・モード）を受けても、スナップショットが届くまでは待ち表示のまま", () => {
    meetingScene(init(false),
      speak("次の質問です。"),
      intake("interrupted"),
      frame({ type: "screen-notice", text: SCREEN }),
      frame({ type: "tap-notice", text: TAP }),
      frame({ type: "diff-update", state: PAUSED }),
      selfPause(true),
      frame({ type: "session-mode", local: true }),
      settle,
      tap(expectOnlyWaiting),
    );
  });

  it("つながった・切れた だけでも、待ち表示のまま", () => {
    meetingScene(init(false), connected(), settle, tap(expectOnlyWaiting), disconnected(), settle, tap(expectOnlyWaiting));
  });
});

describe("会議中の Scene: 最初のスナップショットで画面が出て、それまでに届いていた値も同時に出る", () => {
  it("待ち表示が消え、.layout の直下は ローカルモード → .map → 字幕 → 取り込み → 共有画面 → 相手の音声 → 差分更新 → .side の順になる", () => {
    meetingScene(init(false),
      speak("次の質問です。"),
      intake("interrupted"),
      frame({ type: "screen-notice", text: SCREEN }),
      frame({ type: "tap-notice", text: TAP }),
      frame({ type: "diff-update", state: PAUSED }),
      frame({ type: "session-mode", local: true }),
      frame(FIRST),
      settle,
      tap((sim) => {
        expect(findAll(sim.html, "p.waiting")).toHaveLength(0);
        expect(layoutOutline(sim.html)).toEqual(["local-mode-line", "local-mode-notice", "map", "captions", "intake-notice", "screen-notice", "tap-notice", "diff-update-notice", "side"]);
        expect(findAll(one(sim.html, ".map"), ".map-surface")).toHaveLength(1);
        expect(texts(sim.html, ".captions__bubble")).toEqual(["次の質問です。"]);
        expect(texts(sim.html, ".intake-notice")).toEqual([INTERRUPTED]);
        expect(texts(sim.html, ".screen-notice")).toEqual([SCREEN]);
        expect(texts(sim.html, ".tap-notice")).toEqual([TAP]);
        expect(texts(sim.html, ".diff-update-notice")).toEqual([PAUSED_TEXT]);
        expect(texts(sim.html, ".local-mode-notice")).toEqual(["ローカルモード・Apple Intelligence"]);
      }),
      expectScene(selector(".layout--local")).toExist(),
    );
  });

  it("スナップショットだけなら、.layout の直下は .map → 字幕なし → .side だけ。ノードは反映 1 の内容（root・A）で、取り込みの知らせは出ない（動いている）", () => {
    meetingScene(init(false),
      frame(FIRST),
      settle,
      tap((sim) => {
        expect(layoutOutline(sim.html)).toEqual(["map", "side"]);
        expect(renderedIds(sim.html)).toEqual(["root", "A"]);
        expect(texts(sim.html, ".changes__item")).toHaveLength(1);
      }),
      expectScene(selector(".layout--local")).toBeAbsent(),
    );
  });

  it("isMac は表示面へ届く: Mac の ⌘＋スクロールは動かさず、Mac 以外の ⌘＋スクロールは動かす", () => {
    const wheel = surface(MapSurfaceMessage.WheeledMapSurface({ x: 0, y: 0, deltaX: 0, deltaY: 100, deltaMode: 0, shiftKey: false, ctrlKey: false, metaKey: true, timeStamp: 1 }));
    let atMac: ReturnType<typeof viewportOf>;
    meetingScene(init(true),
      frame(FIRST),
      settle,
      tap((sim) => (atMac = viewportOf(sim.html))),
      wheel,
      tap((sim) => expect(viewportOf(sim.html)).toEqual(atMac)),
    );
    let atOther: ReturnType<typeof viewportOf>;
    meetingScene(init(false),
      frame(FIRST),
      settle,
      tap((sim) => (atOther = viewportOf(sim.html))),
      wheel,
      tap((sim) => expect(viewportOf(sim.html)).not.toEqual(atOther)),
    );
  });
});

describe("会議中の Scene: frame が画面まで届く（受けると出て、null や切れたことで消える）", () => {
  it("共有画面の一文: 受けると .layout の直下に出て、null の frame でその場で消える。もう一度受けると出る", () => {
    meetingScene(init(false),
      frame(FIRST),
      settle,
      frame({ type: "screen-notice", text: SCREEN }),
      settle,
      expectScene(selector(".screen-notice")).toHaveText(SCREEN),
      tap((sim) => expect(layoutOutline(sim.html)).toEqual(["map", "screen-notice", "side"])),
      frame({ type: "screen-notice", text: null }),
      expectScene(selector(".screen-notice")).toBeAbsent(),
      settle,
      frame({ type: "screen-notice", text: SCREEN }),
      settle,
      expectScene(selector(".screen-notice")).toHaveText(SCREEN),
    );
  });

  it("相手の音声が届いていない一文（Issue #863）: 受けると共有画面の一文の後ろに出て、null の frame で消える。共有画面の一文には触れない", () => {
    meetingScene(init(false),
      frame(FIRST),
      settle,
      frame({ type: "screen-notice", text: SCREEN }),
      frame({ type: "tap-notice", text: TAP }),
      settle,
      tap((sim) => {
        expect(layoutOutline(sim.html)).toEqual(["map", "screen-notice", "tap-notice", "side"]);
        expect(texts(sim.html, ".tap-notice")).toEqual([TAP]);
      }),
      frame({ type: "tap-notice", text: null }),
      settle,
      expectScene(selector(".tap-notice")).toBeAbsent(),
      expectScene(selector(".screen-notice")).toHaveText(SCREEN),
    );
  });

  it("差分更新の状態: 一時停止（ChatGPT の利用上限）の間だけ指定文が role=status で出る。動作中・再開・null では出ない。マップと字幕は残る", () => {
    meetingScene(init(false),
      speak("続いている字幕。"),
      frame(FIRST),
      settle,
      frame({ type: "diff-update", state: { status: "running" } }),
      expectScene(selector(".diff-update-notice")).toBeAbsent(),
      frame({ type: "diff-update", state: PAUSED }),
      expectScene(selector(".diff-update-notice")).toHaveText(PAUSED_TEXT),
      expectScene(selector(".diff-update-notice")).toHaveAttr("role", "status"),
      expectScene(selector(".captions__bubble")).toHaveText("続いている字幕。"),
      expectScene(selector(".map-surface")).toExist(),
      frame({ type: "diff-update", state: { status: "running" } }),
      expectScene(selector(".diff-update-notice")).toBeAbsent(),
      frame({ type: "diff-update", state: PAUSED }),
      frame({ type: "diff-update", state: null }),
      expectScene(selector(".diff-update-notice")).toBeAbsent(),
    );
  });

  it("ローカルモード: session-mode で線と文が出て .layout--local になり、差分更新の状態で文言が変わる。false で消える", () => {
    meetingScene(init(false),
      frame(FIRST),
      settle,
      frame({ type: "session-mode", local: true }),
      expectScene(selector(".layout--local")).toExist(),
      expectScene(selector(".local-mode-line")).toExist(),
      expectScene(selector(".local-mode-line")).toHaveAttr("aria-hidden", "true"),
      expectScene(selector(".local-mode-notice")).toHaveText("ローカルモード・Apple Intelligence"),
      expectScene(selector(".local-mode-notice")).toHaveAttr("role", "status"),
      frame({ type: "diff-update", state: { status: "restarting" } }),
      expectScene(selector(".local-mode-notice")).toHaveText("ローカルモード・Apple Intelligence・マップの更新を再開しています"),
      expectScene(selector(".local-mode-notice")).toHaveAttr("data-status", "restarting"),
      frame({ type: "diff-update", state: { status: "stopped" } }),
      expectScene(selector(".local-mode-notice")).toHaveText("ローカルモード・Apple Intelligence・マップの更新が止まっています"),
      frame({ type: "session-mode", local: false }),
      expectScene(selector(".layout--local")).toBeAbsent(),
      expectScene(selector(".local-mode-notice")).toBeAbsent(),
      expectScene(selector(".local-mode-line")).toBeAbsent(),
    );
  });

  it("字幕: captions の frame に追従し（吹き出しを話し始めの順に 1 列に出す）、空の並びにすると .captions ごと消える", () => {
    meetingScene(init(false),
      frame(FIRST),
      settle,
      expectScene(selector(".captions")).toBeAbsent(),
      speak("一つ目です。二つ目です。"),
      tap((sim) => expect(texts(sim.html, ".captions__bubble")).toEqual(["一つ目です。二つ目です。"])),
      frame({ type: "captions", bubbles: [spokenBubble("一つ目です。", "相手", 1), spokenBubble("はい。", "自分", 2)] }),
      tap((sim) => {
        expect(texts(sim.html, ".captions__bubble")).toEqual(["一つ目です。", "はい。"]);
        expect(texts(sim.html, ".captions__name")).toEqual(["相手 A", ""]);
      }),
      frame({ type: "captions", bubbles: [] }),
      expectScene(selector(".captions")).toBeAbsent(),
    );
  });
});

describe("会議中の Scene: 取り込みの知らせ（途切れ → 再開しました）", () => {
  it("動いている間は出ない。途切れると出て、動き出すと『再開しました』に変わり、時間切れで消える", () => {
    meetingScene(init(false),
      frame(FIRST),
      settle,
      expectScene(selector(".intake-notice")).toBeAbsent(),
      intake("running"),
      settle,
      expectScene(selector(".intake-notice")).toBeAbsent(),
      intake("interrupted"),
      settle,
      expectScene(selector(".intake-notice")).toHaveText(INTERRUPTED),
      expectScene(selector(".intake-notice")).toHaveAttr("aria-live", "polite"),
      tap((sim) => expect(timers(sim)).toHaveLength(0)),
      intake("running"),
      settle,
      expectScene(selector(".intake-notice")).toHaveText(RESUMED),
      tap((sim) => expect(timers(sim)).toHaveLength(1)),
      expire,
      settle,
      expectScene(selector(".intake-notice")).toBeAbsent(),
    );
  });

  it("止まった（stopped）は状態が変わるまで残り、動き出すと『再開しました』。none（セッションが終わった）では出ない", () => {
    meetingScene(init(false),
      frame(FIRST),
      settle,
      intake("stopped"),
      settle,
      expectScene(selector(".intake-notice")).toHaveText(STOPPED),
      intake("interrupted"),
      settle,
      expectScene(selector(".intake-notice")).toHaveText(INTERRUPTED),
      intake("none"),
      settle,
      expectScene(selector(".intake-notice")).toBeAbsent(),
      intake("running"),
      settle,
      expectScene(selector(".intake-notice")).toBeAbsent(),
    );
  });

  it("最初のスナップショットの前に途切れていた状態も、スナップショットが来た時点から出る。その後 running で『再開しました』になる", () => {
    meetingScene(init(false),
      intake("interrupted"),
      frame(FIRST),
      settle,
      expectScene(selector(".intake-notice")).toHaveText(INTERRUPTED),
      intake("running"),
      settle,
      expectScene(selector(".intake-notice")).toHaveText(RESUMED),
      expire,
      settle,
      expectScene(selector(".intake-notice")).toBeAbsent(),
    );
  });

  it("同じ状態をもう一度受けても、知らせは作り直さない（時間切れのタイマーが新しく増えない）", () => {
    meetingScene(
      init(false),
      frame(FIRST),
      intake("interrupted"),
      intake("running"),
      tap((sim) => expect(timers(sim)).toHaveLength(1)),
      // 次の流しの前に、先のタイマーは閉じられる。同じ running をもう一度受けても、新しいタイマーは増えない
      intake("running"),
      tap((sim) => expect(timers(sim)).toHaveLength(0)),
      expectScene(selector(".intake-notice")).toHaveText(RESUMED),
    );
  });
});

describe("会議中の Scene: 自分の休止（M・休止中の一言）", () => {
  it("休止の frame で一言が出て（aria-live: polite）、再開の frame で消える。時間では消えない", () => {
    meetingScene(init(false),
      frame(FIRST),
      settle,
      expectScene(selector(".self-pause-notice")).toBeAbsent(),
      selfPause(true),
      settle,
      expectScene(selector(".self-pause-notice")).toHaveText(SELF_PAUSE_TEXT),
      expectScene(selector(".self-pause-notice")).toHaveAttr("aria-live", "polite"),
      tap((sim) => expect(timers(sim)).toHaveLength(0)),
      selfPause(true),
      settle,
      expectScene(selector(".self-pause-notice")).toHaveText(SELF_PAUSE_TEXT),
      tap((sim) => expect(findAll(sim.html, ".self-pause-notice")).toHaveLength(1)),
      selfPause(false),
      settle,
      expectScene(selector(".self-pause-notice")).toBeAbsent(),
    );
  });

  // Issue #1071: 理由で一言が変わる。同じ画面（同じ Model）の上で、手動 → 自動 → 再開 → 自動と続けて観測する
  it("休止の理由で一言の文言が変わる。休止中に理由だけ変わっても、一言は 1 つのまま置き換わり、再開で消える", () => {
    meetingScene(init(false),
      frame(FIRST),
      settle,
      selfPause(true, "自動"),
      settle,
      expectScene(selector(".self-pause-notice")).toHaveText(SELF_PAUSE_AUTO_TEXT),
      expectScene(selector(".self-pause-notice")).toHaveAttr("aria-live", "polite"),
      selfPause(true, "手動"),
      settle,
      expectScene(selector(".self-pause-notice")).toHaveText(SELF_PAUSE_TEXT),
      tap((sim) => expect(findAll(sim.html, ".self-pause-notice")).toHaveLength(1)),
      selfPause(true, "自動"),
      settle,
      expectScene(selector(".self-pause-notice")).toHaveText(SELF_PAUSE_AUTO_TEXT),
      tap((sim) => expect(findAll(sim.html, ".self-pause-notice")).toHaveLength(1)),
      selfPause(false),
      settle,
      expectScene(selector(".self-pause-notice")).toBeAbsent(),
      selfPause(true, "自動"),
      settle,
      expectScene(selector(".self-pause-notice")).toHaveText(SELF_PAUSE_AUTO_TEXT),
    );
  });

  it("自動の休止中の M は、手動のときと同じく逆の状態（paused:false）を指示に載せる。M の動きは理由で変わらない", () => {
    meetingScene(init(false),
      frame(FIRST),
      settle,
      selfPause(true, "自動"),
      settle,
      raw(press("M")),
      tap((sim) => expect(selfPauseRequests(sim)).toEqual([false])),
      settle,
      expectScene(selector(".self-pause-notice")).toHaveText(SELF_PAUSE_AUTO_TEXT),
    );
  });

  it("最初のスナップショットの前に届いていた休止も、スナップショットが来た時点から出る", () => {
    meetingScene(init(false),
      selfPause(true),
      frame(FIRST),
      settle,
      expectScene(selector(".self-pause-notice")).toHaveText(SELF_PAUSE_TEXT),
    );
  });

  it("一言が出ても、マップ・字幕の描画は変わらない。.layout の直下は 字幕 → 一言 → .side の並びで、包む要素は増えない", () => {
    let before: { map: unknown; captions: unknown };
    meetingScene(init(false),
      speak("字幕です。"),
      frame(FIRST),
      settle,
      tap((sim) => (before = { map: shapeOf(one(sim.html, ".map")), captions: shapeOf(one(sim.html, ".captions")) })),
      selfPause(true),
      settle,
      tap((sim) => {
        expect(shapeOf(one(sim.html, ".map"))).toEqual(before.map);
        expect(shapeOf(one(sim.html, ".captions"))).toEqual(before.captions);
        const outline = layoutOutline(sim.html);
        expect(outline.filter((name) => name !== "self-pause-notice")).toEqual(["map", "captions", "side"]);
        expect(outline.indexOf("self-pause-notice")).toBeGreaterThan(outline.indexOf("captions"));
        expect(outline.indexOf("self-pause-notice")).toBeLessThan(outline.indexOf("side"));
      }),
    );
  });

  it("取り込みの一言（途切れ）と同時に出ても、どちらも別の要素として残り、片方が消えても他方は残る", () => {
    meetingScene(init(false),
      frame(FIRST),
      intake("interrupted"),
      selfPause(true),
      settle,
      tap((sim) => {
        expect(texts(sim.html, ".intake-notice")).toEqual([INTERRUPTED]);
        expect(texts(sim.html, ".self-pause-notice")).toEqual([SELF_PAUSE_TEXT]);
      }),
      intake("running"),
      settle,
      selfPause(false),
      settle,
      expectScene(selector(".self-pause-notice")).toBeAbsent(),
      expectScene(selector(".intake-notice")).toHaveText(RESUMED),
    );
  });

  it("M: 画面に見えている状態の逆を指示に載せる。押しただけでは一言を出さず、frame が届いて初めて切り替わる（休止中の M は paused:false）", () => {
    meetingScene(init(false),
      frame(FIRST),
      settle,
      raw(press("M")),
      tap((sim) => expect(selfPauseRequests(sim)).toEqual([true])),
      settle,
      expectScene(selector(".self-pause-notice")).toBeAbsent(),
      selfPause(true),
      settle,
      expectScene(selector(".self-pause-notice")).toExist(),
      raw(press("M")),
      tap((sim) => expect(selfPauseRequests(sim)).toEqual([false])),
      settle,
      expectScene(selector(".self-pause-notice")).toExist(),
      selfPause(false),
      settle,
      expectScene(selector(".self-pause-notice")).toBeAbsent(),
      raw(press("M")),
      tap((sim) => expect(selfPauseRequests(sim)).toEqual([true])),
      settle,
    );
  });

  it("M: 切れると見えている状態が空に戻るので次の M は paused:true。つなぎ直して server が休止を送り直すと、また paused:false", () => {
    meetingScene(init(false),
      connected(),
      frame(FIRST),
      selfPause(true),
      settle,
      expectScene(selector(".self-pause-notice")).toExist(),
      disconnected(),
      settle,
      expectScene(selector(".self-pause-notice")).toBeAbsent(),
      raw(press("M")),
      tap((sim) => expect(selfPauseRequests(sim)).toEqual([true])),
      settle,
      connected(),
      frame(FIRST),
      selfPause(true),
      settle,
      expectScene(selector(".self-pause-notice")).toHaveText(SELF_PAUSE_TEXT),
      raw(press("M")),
      tap((sim) => expect(selfPauseRequests(sim)).toEqual([false])),
      settle,
    );
  });

  it("M: ⌘・Ctrl・Option と一緒なら指示を出さない。スナップショットが届くまでも出さない", () => {
    meetingScene(init(false),
      raw(press("M")),
      tap((sim) => expect(selfPauseRequests(sim)).toEqual([])),
      frame(FIRST),
      settle,
      raw(press("M", { metaKey: true })),
      raw(press("M", { ctrlKey: true })),
      raw(press("M", { altKey: true })),
      tap((sim) => expect(selfPauseRequests(sim)).toEqual([])),
      settle,
    );
  });

  it("M は休止の指示だけを出し、ほかの表示（字幕・マップ・キーの一覧）には触れない", () => {
    let before: unknown;
    meetingScene(init(false),
      speak("字幕です。"),
      frame(FIRST),
      settle,
      tap((sim) => (before = shapeOf(sim.html))),
      raw(press("M")),
      tap((sim) => {
        expect(commandNames(sim)).toEqual(["RequestSelfPause"]);
        expect(shapeOf(sim.html)).toEqual(before);
      }),
      settle,
    );
  });
});

describe("会議中の Scene: 切れる・つなぎ直すをまたいで、同じ画面が最新の状態に合わせて動く", () => {
  it("切れると 共有画面・相手の音声・ローカルモード の表示が消え、スナップショット・字幕・取り込みの知らせ・差分更新・選択は残る。つなぎ直すと字幕が空に戻り、取り込みの知らせは保たれる。server が送り直した値でまた出る", () => {
    let reference = referenceOf(FIRST);
    meetingScene(init(false),
      connected(),
      frame(FIRST),
      settle,
      speak("途中の字幕。"),
      intake("interrupted"),
      frame({ type: "screen-notice", text: SCREEN }),
      frame({ type: "tap-notice", text: TAP }),
      frame({ type: "diff-update", state: PAUSED }),
      frame({ type: "session-mode", local: true }),
      settle,
      // 変わったことの項目を押して A を選ぶ（この選択が、切断・再接続をまたいで残る）
      click(selector("button.changes__button")),
      settle,
      tap((sim) => {
        reference = referenceUpdate(reference, MapSurfaceMessage.ClickedChangeItem({ nodeId: "A" }));
        expect(selectedIds(sim.html)).toEqual(["A"]);
      }),
      disconnected(),
      settle,
      tap((sim) => {
        expect(findAll(sim.html, ".screen-notice")).toHaveLength(0);
        expect(findAll(sim.html, ".tap-notice")).toHaveLength(0);
        expect(findAll(sim.html, ".local-mode-notice")).toHaveLength(0);
        expect(findAll(sim.html, ".layout--local")).toHaveLength(0);
        // 残るもの
        expect(texts(sim.html, ".captions__bubble")).toEqual(["途中の字幕。"]);
        expect(texts(sim.html, ".intake-notice")).toEqual([INTERRUPTED]);
        expect(texts(sim.html, ".diff-update-notice")).toEqual([PAUSED_TEXT]);
        expect(renderedIds(sim.html)).toEqual(["root", "A"]);
        expect(selectedIds(sim.html)).toEqual(["A"]);
        expect(findAll(sim.html, ".map-surface")).toHaveLength(1);
        const r = matchesReference(sim.html, reference);
        expect(r.selected).toEqual(r.expectedSelected);
      }),
      connected(),
      settle,
      tap((sim) => {
        // つなぎ直しで字幕は空に戻り、取り込みの知らせは「動いている」を作り出さずに保たれる
        expect(findAll(sim.html, ".captions")).toHaveLength(0);
        expect(texts(sim.html, ".intake-notice")).toEqual([INTERRUPTED]);
        expect(selectedIds(sim.html)).toEqual(["A"]);
      }),
      // server が、つないだら保持している値を先に送り直す
      frame(FIRST),
      frame({ type: "screen-notice", text: SCREEN }),
      frame({ type: "session-mode", local: true }),
      speak("つなぎ直した後の字幕。"),
      settle,
      tap((sim) => {
        expect(texts(sim.html, ".screen-notice")).toEqual([SCREEN]);
        expect(texts(sim.html, ".captions__bubble")).toEqual(["つなぎ直した後の字幕。"]);
        expect(findAll(sim.html, ".layout--local")).toHaveLength(1);
        expect(texts(sim.html, ".intake-notice")).toEqual([INTERRUPTED]);
        // 表示面は作り直さない: 選択もビューポートも同じ
        expect(selectedIds(sim.html)).toEqual(["A"]);
        const r = matchesReference(sim.html, reference);
        expect(r.selected).toEqual(r.expectedSelected);
      }),
    );
  });

  it("切れて・つなぎ直した後の取り込み: 途切れのまま→サーバーが running を送ると『再開しました』が出る（つなぎ直しだけでは出ない）", () => {
    meetingScene(init(false),
      frame(FIRST),
      settle,
      intake("interrupted"),
      settle,
      disconnected(),
      connected(),
      settle,
      expectScene(selector(".intake-notice")).toHaveText(INTERRUPTED),
      intake("running"),
      settle,
      expectScene(selector(".intake-notice")).toHaveText(RESUMED),
      expire,
      settle,
    );
  });

  it("切れる・つなぎ直す を繰り返しても、そのつど最新の値に追従する（共有画面の一文が出る → 切れて消える → 別の一文が出る）", () => {
    meetingScene(init(false),
      connected(),
      frame(FIRST),
      frame({ type: "screen-notice", text: SCREEN }),
      settle,
      expectScene(selector(".screen-notice")).toHaveText(SCREEN),
      disconnected(),
      connected(),
      settle,
      expectScene(selector(".screen-notice")).toBeAbsent(),
      frame({ type: "screen-notice", text: "別の一文" }),
      settle,
      expectScene(selector(".screen-notice")).toHaveText("別の一文"),
      disconnected(),
      settle,
      expectScene(selector(".screen-notice")).toBeAbsent(),
      connected(),
      frame({ type: "screen-notice", text: SCREEN }),
      settle,
      expectScene(selector(".screen-notice")).toHaveText(SCREEN),
    );
  });

});

describe("会議中の Scene: 反映（新しいスナップショット）で、同じ画面の表示面・右の列が新しい内容に合わせて変わる", () => {
  it("ノード・変わったこと・点滅の Command が新しい内容になる。選択と人が動かしたカメラは保たれ、表示面は作り直されない", () => {
    let reference = referenceOf(FIRST);
    meetingScene(init(false),
      frame(FIRST),
      settle,
      tap((sim) => expect(commandNames(sim)).toEqual([])),
      // 人が選んで拡大した状態（manual）にしてから反映を受ける
      click(selector("button.changes__button")),
      settle,
      press("="),
      settle,
      tap((sim) => {
        reference = referenceUpdate(reference, MapSurfaceMessage.ClickedChangeItem({ nodeId: "A" }));
        reference = referencePress(reference, "=");
        const r = matchesReference(sim.html, reference);
        expect(r.selected).toEqual(["A"]);
        expect(r.selected).toEqual(r.expectedSelected);
        expect(texts(sim.html, ".viewing-notice")).toEqual([MANUAL]);
      }),
      frameRaw(SECOND),
      tap((sim) => {
        // 反映で、点滅を最初から再生し直す Command が出る（測定済みで、反映の番号が変わり、変わったノードがあるため）
        expect(commandNames(sim)).toContain("RestartBlink");
      }),
      settle,
      tap((sim) => {
        const before = reference;
        reference = referenceUpdate(reference, MapSurfaceMessage.ChangedSnapshot({ snapshot: SECOND }));
        expect(renderedIds(sim.html)).toEqual(["root", "A", "A1", "B"]);
        expect(texts(sim.html, ".changes__item")).toHaveLength(SECOND.changes.length);
        // 選択も、止めたカメラも、表示面の反映（changedSnapshot）の結果と同じ
        const r = matchesReference(sim.html, reference);
        expect(r.selected).toEqual(r.expectedSelected);
        expect(r.selected).toEqual(["A"]);
        expect(texts(sim.html, ".viewing-notice")).toEqual(noticeTextOf(reference));
        expect(reference).not.toEqual(before);
        expect(findAll(sim.html, ".map-surface")).toHaveLength(1);
      }),
    );
  });

  it("補間: 反映で位置が動く間は、フレームを進めると表示面（MapSurface）と同じ位置になり、補間が終わると目標の位置に着く", () => {
    let reference = referenceOf(FIRST);
    meetingScene(init(false),
      frame(FIRST),
      settle,
      frame(SECOND),
      settle,
      surface(MapSurfaceMessage.TickedAnimationFrame({ deltaMs: 100 })),
      tap((sim) => {
        reference = referenceUpdate(reference, MapSurfaceMessage.ChangedSnapshot({ snapshot: SECOND }));
        reference = referenceUpdate(reference, MapSurfaceMessage.TickedAnimationFrame({ deltaMs: 100 }));
        const r = matchesReference(sim.html, reference);
        expect(r.selected).toEqual(r.expectedSelected);
      }),
      surface(MapSurfaceMessage.TickedAnimationFrame({ deltaMs: 1000 })),
      tap((sim) => {
        reference = referenceUpdate(reference, MapSurfaceMessage.TickedAnimationFrame({ deltaMs: 1000 }));
        matchesReference(sim.html, reference);
      }),
    );
  });

  it("自動のカメラ（今の議題を追う）は、反映で今の議題が変わると新しい議題へ動く", () => {
    let reference = referenceOf(FIRST);
    let atFirst: ReturnType<typeof viewportOf>;
    meetingScene(init(false),
      frame(FIRST),
      settle,
      tap((sim) => {
        atFirst = viewportOf(sim.html);
        matchesReference(sim.html, reference);
      }),
      frame(SECOND),
      settle,
      surface(MapSurfaceMessage.TickedAnimationFrame({ deltaMs: 2000 })),
      tap((sim) => {
        reference = referenceUpdate(reference, MapSurfaceMessage.ChangedSnapshot({ snapshot: SECOND }));
        reference = referenceUpdate(reference, MapSurfaceMessage.TickedAnimationFrame({ deltaMs: 2000 }));
        expect(reference.viewing.mode).toBe("auto");
        matchesReference(sim.html, reference);
        expect(viewportOf(sim.html)).not.toEqual(atFirst);
      }),
    );
  });

  it("変わったことの無い反映（round だけ進む）では、点滅の再生し直しの Command は出ない。同じ round の再送でも出ない", () => {
    meetingScene(init(false),
      frame(SECOND),
      settle,
      frameRaw(THIRD_QUIET),
      tap((sim) => expect(commandNames(sim)).not.toContain("RestartBlink")),
      settle,
      frameRaw(THIRD_QUIET),
      tap((sim) => expect(commandNames(sim)).not.toContain("RestartBlink")),
      settle,
    );
  });

  it("最初のスナップショットでは点滅の再生し直しは出ない。字幕・知らせの frame でも出ない", () => {
    meetingScene(init(false),
      frameRaw(FIRST),
      tap((sim) => expect(commandNames(sim)).not.toContain("RestartBlink")),
      settle,
      frameRaw(spokenFrame("字幕。", "相手")),
      tap((sim) => expect(commandNames(sim)).not.toContain("RestartBlink")),
      settle,
      frameRaw({ type: "screen-notice", text: SCREEN }),
      tap((sim) => expect(commandNames(sim)).not.toContain("RestartBlink")),
      settle,
    );
  });

  it("右の列は反映に追従し、選んだノードの根拠も新しい内容になる", () => {
    meetingScene(init(false),
      frame(FIRST),
      settle,
      click(selector("button.changes__button")),
      settle,
      tap((sim) => expect(texts(sim.html, ".evidence__text")).toEqual(["採用"])),
      frame({ ...FIRST, nodes: FIRST.nodes.map((n) => (n.id === "A" ? { ...n, text: "採用（更新）" } : n)), round: 2, changes: [...FIRST.changes, { round: 2, at: 20, change: "更新", node: "A", kind: "議題", text: "採用（更新）" }] }),
      settle,
      tap((sim) => {
        expect(texts(sim.html, ".evidence__text")).toEqual(["採用（更新）"]);
        expect(selectedIds(sim.html)).toEqual(["A"]);
      }),
    );
  });
});

describe("会議中の Scene: キー（会議中の行だけ。見返しのキーは効かない）", () => {
  const SEQUENCE: ReadonlyArray<KeyId> = ["ArrowRight", "ArrowDown", "=", "Shift+ArrowLeft", "Shift+ArrowUp", "-", "Z", "F", "F", "0", "Escape", "Escape", "ArrowLeft", "Enter"];

  it("表示面のキー（拡大・縮小・倍率・全体・寄る・移動・矢印・Enter・Esc）は、live の表示面に同じキーを押した結果と一致する。1 つずつ続けて押す", () => {
    let reference = referenceOf(SECOND);
    const steps = SEQUENCE.flatMap((key) => [
      press(key),
      settle,
      tap<Model, MeetingMessage>((sim) => {
        reference = referencePress(reference, key);
        const r = matchesReference(sim.html, reference);
        expect(r.selected, key).toEqual(r.expectedSelected);
        expect(texts(sim.html, ".viewing-notice"), key).toEqual(noticeTextOf(reference));
      }),
    ]);
    meetingScene(init(false), frame(SECOND), settle, ...steps);
  });

  it("⌘・Ctrl・Option と一緒のキー（表示面のキー）は、表示面には届かない形で渡されても、表示面の規則（修飾キー付きは無視）に従う", () => {
    let reference = referenceOf(SECOND);
    meetingScene(init(false),
      frame(SECOND),
      settle,
      press("=", { metaKey: true }),
      settle,
      press("F", { ctrlKey: true }),
      settle,
      press("Shift+ArrowLeft", { altKey: true }),
      settle,
      tap((sim) => {
        reference = referencePress(referencePress(referencePress(reference, "=", { metaKey: true, ctrlKey: false, altKey: false }), "F", { metaKey: false, ctrlKey: true, altKey: false }), "Shift+ArrowLeft", { metaKey: false, ctrlKey: false, altKey: true });
        const r = matchesReference(sim.html, reference);
        expect(r.selected).toEqual(r.expectedSelected);
      }),
    );
  });

  it("E: 右の列を隠し、もう一度の E で戻す。字幕には触らない。⌘・Ctrl・Option と一緒では隠さない", () => {
    meetingScene(init(false),
      speak("字幕です。"),
      frame(FIRST),
      settle,
      expectScene(selector(".side")).toExist(),
      press("E", { metaKey: true }),
      press("E", { ctrlKey: true }),
      press("E", { altKey: true }),
      settle,
      expectScene(selector(".side")).toExist(),
      press("E"),
      settle,
      expectScene(selector(".side")).toBeAbsent(),
      expectScene(selector(".captions")).toExist(),
      tap((sim) => expect(layoutOutline(sim.html)).toEqual(["map", "captions"])),
      press("E"),
      settle,
      expectScene(selector(".side")).toExist(),
    );
  });

  it("C: 字幕を隠し、もう一度の C で戻す。右の列には触らない。⌘・Ctrl・Option と一緒では隠さない。隠している間に来た字幕は、戻すと見える", () => {
    meetingScene(init(false),
      speak("字幕です。"),
      frame(FIRST),
      settle,
      press("C", { metaKey: true }),
      press("C", { ctrlKey: true }),
      press("C", { altKey: true }),
      settle,
      expectScene(selector(".captions")).toExist(),
      press("C"),
      settle,
      expectScene(selector(".captions")).toBeAbsent(),
      expectScene(selector(".side")).toExist(),
      speak("隠している間の字幕。"),
      settle,
      expectScene(selector(".captions")).toBeAbsent(),
      press("C"),
      settle,
      tap((sim) => expect(texts(sim.html, ".captions__bubble")).toEqual(["隠している間の字幕。"])),
    );
  });

  it("?: キーの一覧は .map の中に、会議中の行だけで開く。見返しのキー（Space・K / J / L / Home / End）は載らず、M は自分の休止・再開の行として載る。もう一度の ? で閉じる", () => {
    meetingScene(init(false),
      frame(FIRST),
      settle,
      expectScene(selector(".key-list")).toBeAbsent(),
      press("?"),
      settle,
      tap((sim) => {
        const list = one(sim.html, ".map .key-list");
        const labels = texts(list, ".key-list__keys");
        expect(labels).toEqual(keyListRows("live").map((row) => row.keys));
        for (const review of ["Space・K", "J / L", ", / .", "< / >", "Home / End"]) expect(labels).not.toContain(review);
        expect(labels).toContain("M");
        expect(texts(list, ".key-list__row")).toContain("M 自分を休止・再開");
        expect(texts(list, ".key-list__row").some((row) => row.includes("ミュート"))).toBe(false);
        expect(findAll(one(sim.html, ".layout"), ".side .key-list")).toHaveLength(0);
      }),
      press("?"),
      // 閉じると、キーの一覧の Mount が外れる
      Mount.expectEnded(Popover.AnchorPopover),
      expectScene(selector(".key-list")).toBeAbsent(),
    );
  });

  it("Esc: キーの一覧が開いているときは一覧を閉じるだけで、見る状態（拡大して止めた状態）は戻さない。もう一度の Esc で戻る", () => {
    meetingScene(init(false),
      frame(SECOND),
      settle,
      press("="),
      settle,
      press("?"),
      settle,
      expectScene(selector(".key-list")).toExist(),
      press("Escape"),
      Mount.expectEnded(Popover.AnchorPopover),
      expectScene(selector(".key-list")).toBeAbsent(),
      expectScene(selector(".viewing-notice")).toHaveText(MANUAL),
      press("Escape"),
      settle,
      expectScene(selector(".viewing-notice")).toBeAbsent(),
    );
  });

  it("見返しのキー（Space・K・J・L・, . < > Home End）を押しても、会議中の画面は何も変わらず、Command も出ない", () => {
    const REVIEW_ONLY = ["Space", "K", "J", "L", ",", ".", "<", ">", "Home", "End"] as const satisfies ReadonlyArray<KeyId>;
    let before: unknown;
    const steps = REVIEW_ONLY.flatMap((key) => [
      press(key),
      tap<Model, MeetingMessage>((sim) => {
        expect(commandNames(sim), key).toEqual([]);
        expect(shapeOf(sim.html), key).toEqual(before);
      }),
    ]);
    meetingScene(init(false),
      speak("字幕です。"),
      frame(SECOND),
      settle,
      tap((sim) => (before = shapeOf(sim.html))),
      ...steps,
    );
  });
});

describe("会議中の Scene: 変わったことの列と根拠のパネル", () => {
  it("変わったことの項目を押すと、そのノードが選ばれ、根拠のパネルに根拠の発言が出る（pointChange）", () => {
    meetingScene(init(false),
      frame(FIRST),
      settle,
      expectScene(selector(".evidence__empty")).toHaveText("ノードを選ぶと、根拠の発言が出ます"),
      click(selector("button.changes__button")),
      settle,
      tap((sim) => {
        expect(selectedIds(sim.html)).toEqual(["A"]);
        expect(texts(sim.html, ".evidence__text")).toEqual(["採用"]);
        expect(texts(sim.html, ".evidence__remark-text")).toEqual(["採用の話をします"]);
        const reference = referenceUpdate(referenceOf(FIRST), MapSurfaceMessage.ClickedChangeItem({ nodeId: "A" }));
        const r = matchesReference(sim.html, reference);
        expect(r.selected).toEqual(r.expectedSelected);
      }),
    );
  });

  it("スナップショットに無いノードの項目を押すと、選ぶだけ（カメラは動かさず、根拠のパネルは『今のマップにありません』）", () => {
    const withGone: Snapshot = { ...FIRST, changes: [{ round: 1, at: 12, change: "却下", node: "gone", kind: "議題", text: "消えた議題" }] };
    let atStart: ReturnType<typeof viewportOf>;
    meetingScene(init(false),
      frame(withGone),
      settle,
      tap((sim) => (atStart = viewportOf(sim.html))),
      click(selector("button.changes__button")),
      settle,
      tap((sim) => {
        expect(texts(sim.html, ".evidence__empty")).toEqual(["選んだノードは今のマップにありません"]);
        expect(selectedIds(sim.html)).toEqual([]);
        expect(viewportOf(sim.html)).toEqual(atStart);
        const reference = referenceUpdate(referenceOf(withGone), MapSurfaceMessage.ClickedChangeItem({ nodeId: "gone" }));
        const r = matchesReference(sim.html, reference);
        expect(r.selected).toEqual(r.expectedSelected);
      }),
    );
  });

  it("右の列を隠すと、選択は残ったまま .side に side--hidden が付き（広い幅では見えない）、戻すと根拠がそのまま出る", () => {
    meetingScene(init(false),
      frame(FIRST),
      settle,
      click(selector("button.changes__button")),
      settle,
      press("E"),
      settle,
      expectScene(selector(".side.side--hidden")).toExist(),
      tap((sim) => expect(selectedIds(sim.html)).toEqual(["A"])),
      press("E"),
      settle,
      tap((sim) => expect(texts(sim.html, ".evidence__text")).toEqual(["採用"])),
    );
  });
});

describe("会議中の Scene: 自動のカメラは、スナップショットが変わったときだけ動く（今の議題が無い画面）", () => {
  const { currentTopic: _currentTopic, ...NO_TOPIC } = FIRST satisfies Snapshot;
  const remeasuredReference = () =>
    referenceUpdate(
      referencePress(referenceUpdate(referenceOf(NO_TOPIC), MapSurfaceMessage.TickedAnimationFrame({ deltaMs: 2000 })), "E"),
      MapSurfaceMessage.MeasuredMapSurface({ width: 1100, height: 600, nodeHeights: HEIGHTS }),
    );
  const NO_TOPIC_NEXT: Snapshot = { ...NO_TOPIC, round: 2 };
  // 測定・補間を終え、E で右の列を隠して幅を測り直した、自動の見る状態の画面
  const remeasured = [
    frame(NO_TOPIC),
    settle,
    surface(MapSurfaceMessage.TickedAnimationFrame({ deltaMs: 2000 })),
    // 測り直した後は settle しない（settle は保留の Mount を最初の測定（800 の幅）で解き直してしまう）
    raw(press("E")),
    raw(surface(MapSurfaceMessage.MeasuredMapSurface({ width: 1100, height: 600, nodeHeights: HEIGHTS }))),
  ] as const;

  it("スナップショット以外の frame と、切断・再接続を受けても、ビューポートは動かない", () => {
    let atRemeasured: ReturnType<typeof viewportOf>;
    const same = tap((sim: Sim) => expect(viewportOf(sim.html)).toEqual(atRemeasured));
    meetingScene(init(false),
      ...remeasured,
      tap((sim) => {
        atRemeasured = viewportOf(sim.html);
        matchesReference(sim.html, remeasuredReference());
      }),
      frameRaw(spokenFrame("次の質問です。", "相手")), settleCommands, same,
      frameRaw({ type: "intake", status: "interrupted" }), settleCommands, same,
      frameRaw({ type: "screen-notice", text: SCREEN }), settleCommands, same,
      frameRaw({ type: "tap-notice", text: TAP }), settleCommands, same,
      frameRaw({ type: "diff-update", state: PAUSED }), settleCommands, same,
      frameRaw({ type: "session-mode", local: true }), settleCommands, same,
      raw(disconnected()), settleCommands, same,
      raw(connected()), settleCommands, same,
    );
  });

  it("round が変わる新しいスナップショットは反映され、ビューポートが表示面の反映の結果になる", () => {
    let atRemeasured: ReturnType<typeof viewportOf>;
    meetingScene(init(false),
      ...remeasured,
      tap((sim) => (atRemeasured = viewportOf(sim.html))),
      frameRaw(NO_TOPIC_NEXT),
      tap((sim) => {
        const reference = referenceUpdate(remeasuredReference(), MapSurfaceMessage.ChangedSnapshot({ snapshot: NO_TOPIC_NEXT }));
        matchesReference(sim.html, reference);
        expect(viewportOf(sim.html)).not.toEqual(atRemeasured);
      }),
    );
  });
});

describe("会議中の Scene: 題材の前提", () => {
  it("題材の全ノードの高さが測定の入力に入っている（増えるノードも最初の測定で測れる）", () => {
    for (const snapshot of [FIRST, SECOND]) for (const n of snapshot.nodes) expect(HEIGHTS[n.id], n.id).toBeGreaterThan(0);
  });
});

// Issue #1026: 話者の名前。名前の表は /ws の speaker-names の frame でだけ変わる。同じ画面（1 つの Model）の上で 前 → frame → 後 を続けて見る。
describe("会議中の Scene: 話者の名前（Issue #1026）", () => {
  const node = (id: string, parent: string | null, kind: Snapshot["nodes"][number]["kind"], text: string, extra: Partial<Snapshot["nodes"][number]> = {}): Snapshot["nodes"][number] => ({ id, parent, kind, text, evidence: [], ...extra });
  // 案 A1 は相手 A が出し、TODO B は相手 B が担当（期限 10/15）。高さの分かるノード id（HEIGHTS）だけを使う
  const PEOPLE: Snapshot = {
    nodes: [node("root", null, "会議", "定例"), node("A", "root", "議題", "採用"), node("A1", "A", "案", "週 1", { proposer: "相手 A" }), node("B", "root", "TODO", "見積もり", { assigneeSpeaker: "相手 B", due: "10/15" })],
    round: 1,
    changes: [],
    remarks: [],
    currentTopic: "A",
    now: 12,
  };
  const said = (id: string, speaker: string, start: number): CaptionBubble => ({ ...spokenBubble("こんにちは", "相手", start), id, speaker });
  const heard = (...bubbles: CaptionBubble[]) => frame({ type: "captions", bubbles });
  const mine: CaptionBubble = { ...spokenBubble("はい", "自分", 3), id: "m" };
  const names = (...rows: Array<[string, string]>) => frame({ type: "speaker-names", names: rows.map(([label, name]) => ({ label, name })) });
  const captionNames = (sim: Sim) => texts(sim.html, ".captions__name");
  const personLines = (sim: Sim) => [texts(sim.html, '[data-node-id="A1"] .map-node__person'), texts(sim.html, '[data-node-id="B"] .map-node__person')];
  const todoAssignees = (sim: Sim) => texts(sim.html, ".todos__assignee"); // 右の列の TODO の段（Issue #1287）

  it("名前が付くと、それまでの字幕の名前の欄・案の出した人・TODO の担当者が、次のスナップショットを待たずに名前になる。同じ名前を 2 つのラベルに付けても別のラベルのまま。空の表でラベルに戻る", () => {
    meetingScene(init(false),
      frame(PEOPLE),
      heard(said("a", "相手 A", 1), said("b", "相手 B", 2)),
      tap((sim) => {
        expect(captionNames(sim)).toEqual(["相手 A", "相手 B"]);
        expect(personLines(sim)).toEqual([["— 相手 A"], ["→ 相手 B · 10/15"]]);
        expect(todoAssignees(sim)).toEqual(["相手 B"]);
      }),
      names(["相手 B", "田中"]),
      tap((sim) => {
        expect(captionNames(sim)).toEqual(["相手 A", "田中"]);
        expect(personLines(sim)).toEqual([["— 相手 A"], ["→ 田中 · 10/15"]]);
        expect(todoAssignees(sim)).toEqual(["田中"]);
      }),
      names(["相手 A", "田中"], ["相手 B", "田中"]),
      tap((sim) => {
        expect(captionNames(sim)).toEqual(["田中", "田中"]); // 別のラベルの吹き出しは、同じ名前でも両方に出る
        expect(personLines(sim)).toEqual([["— 田中"], ["→ 田中 · 10/15"]]);
        expect(todoAssignees(sim)).toEqual(["田中"]);
      }),
      names(),
      tap((sim) => {
        expect(captionNames(sim)).toEqual(["相手 A", "相手 B"]);
        expect(personLines(sim)).toEqual([["— 相手 A"], ["→ 相手 B · 10/15"]]);
        expect(todoAssignees(sim)).toEqual(["相手 B"]);
      }),
    );
  });

  it("名前を付けた後に届いた吹き出しも、前から出ていた吹き出しも、同じ表で名前になる。自分の欄は名前を出さない", () => {
    meetingScene(init(false),
      frame(PEOPLE),
      names(["相手 B", "田中"]),
      heard(said("a", "相手 A", 1), mine),
      tap((sim) => expect(captionNames(sim)).toEqual(["相手 A", ""])),
      heard(said("a", "相手 A", 1), said("b", "相手 B", 2), mine),
      tap((sim) => expect(captionNames(sim)).toEqual(["相手 A", "田中", ""])),
    );
  });

  // 見せる吹き出しは末尾の 3 個。押せる欄の数は、見せている吹き出しの中で数える
  it("確定した相手のラベルの欄だけが押せる要素。自分の欄・同じ人が続く欄は押せない", () => {
    meetingScene(init(false),
      frame(PEOPLE),
      heard(said("a1", "相手 A", 1), said("a2", "相手 A", 2), mine),
      tap((sim) => {
        expect(captionNames(sim)).toEqual(["相手 A", "", ""]);
        expect(findAll(sim.html, "button.captions__name")).toHaveLength(1); // 押せるのは先頭の 相手 A だけ
        expect(findAll(sim.html, ".captions__name")).toHaveLength(3);
      }),
      heard(said("a2", "相手 A", 2), mine, said("b", "相手 B", 4)),
      tap((sim) => {
        expect(captionNames(sim)).toEqual(["相手 A", "", "相手 B"]);
        expect(findAll(sim.html, "button.captions__name")).toHaveLength(2); // 押せるのは 相手 A と 相手 B の 2 つ
        expect(findAll(sim.html, ".captions__name")).toHaveLength(3);
      }),
    );
  });

  it("欄を押す → 欄の中で入力 → 送信で POST の Command（label はサーバーに送るラベル、name は入力）。送った直後は名前を出さず（楽観的に出さない）、frame が届いてから名前になる", () => {
    meetingScene(init(false),
      frame(PEOPLE),
      heard(said("a", "相手 A", 1), said("b", "相手 B", 2), mine),
      click(selector("button.captions__name")), // 先頭の押せる欄 = 相手 A
      settle, // 入力へのフォーカスの Command を解く
      tap((sim) => {
        expect(findAll(sim.html, ".captions__name input")).toHaveLength(1);
        expect(speakerNameRequests(sim)).toEqual([]);
      }),
      typeInto(selector(".captions__name input"), "田中"),
      submit(selector(".captions form")),
      tap((sim) => {
        expect(speakerNameRequests(sim)).toEqual([{ label: "相手 A", name: "田中" }]);
        expect(findAll(sim.html, ".captions input")).toHaveLength(0); // 送った後は入力を閉じる
        expect(captionNames(sim)).toEqual(["相手 A", "相手 B", ""]); // まだ名前は出ない
      }),
      settle,
      names(["相手 A", "田中"]),
      tap((sim) => expect(captionNames(sim)).toEqual(["田中", "相手 B", ""])),
    );
  });
});
