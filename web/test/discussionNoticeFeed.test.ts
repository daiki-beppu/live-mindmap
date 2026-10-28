import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ViewerFrame } from "../../server/src/core/index.ts";
import { applyClose, applyFrame, applyOpen, createFeedState } from "../src/liveFeed.ts";
import { spokenFrame } from "./fixtures/captions.ts";

const text = "「進め方」が 10 分決まっていません。何を重視して決めるかを先に確かめませんか";
const decode = Schema.decodeUnknownSync(ViewerFrame);

describe("堂々巡りの知らせの受信", () => {
  it("通知の受信・置換・消去が、既に表示したマップと字幕を変えない", () => {
    let state = applyFrame(createFeedState(), decode({
      type: "snapshot", snapshot: { nodes: [{ id: "root", parent: null, kind: "会議", text: "合成会議", evidence: [] }], remarks: [], changes: [], round: 0 },
    }), 0);
    state = applyFrame(state, spokenFrame("表示中の字幕", "相手"), 0);
    const before = state;
    state = applyFrame(state, decode({ type: "discussion-notice", text }), 0);
    expect(state).toHaveProperty("discussionNotice", text);
    expect(state.snapshot).toEqual(before.snapshot);
    expect(state.captions).toEqual(before.captions);
    const nextText = "「導入時期」が 15 分決まっていません。何を重視して決めるかを先に確かめませんか";
    state = applyFrame(state, decode({ type: "discussion-notice", text: nextText }), 0);
    expect(state).toHaveProperty("discussionNotice", nextText);
    state = applyFrame(state, decode({ type: "discussion-notice", text: null }), 0);
    expect(state).toHaveProperty("discussionNotice", null);
    expect(state.snapshot).toEqual(before.snapshot);
    expect(state.captions).toEqual(before.captions);
  });

  it("切断で通知を消去し、再接続した同じfeedで再送された通知を受信する", () => {
    let state = createFeedState();
    state = applyFrame(state, decode({ type: "discussion-notice", text }), 0);
    expect(state).toHaveProperty("discussionNotice", text);
    state = applyClose(state);
    expect(state).toHaveProperty("discussionNotice", null);
    state = applyOpen(state);
    expect(state).toHaveProperty("discussionNotice", null);
    state = applyFrame(state, decode({ type: "discussion-notice", text }), 0);
    expect(state).toHaveProperty("discussionNotice", text);
  });
});
