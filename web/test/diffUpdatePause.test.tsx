import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { DiffUpdateFrame, DiffUpdateState, Snapshot } from "../../server/src/core/index.ts";
import { App } from "../src/App.tsx";
import { applyFrame, createFeedState } from "../src/liveFeed.ts";

const useLiveFeed = vi.hoisted(() => vi.fn());
vi.mock("../src/useLiveFeed.ts", () => ({ useLiveFeed }));
vi.mock("../src/useIntakeNotice.ts", () => ({ useIntakeNotice: () => null }));
vi.mock("../src/MapView.tsx", () => ({ MapView: () => <div className="map-view-stub" /> }));

const message = "マップの更新が止まっています（ChatGPT の利用上限）";
const snapshot: Snapshot = { nodes: [{ id: "root", parent: null, kind: "会議", text: "定例", evidence: [] }], round: 0, changes: [], remarks: [] };
const paused = { status: "paused", reason: "ChatGPT の利用上限" } as const;
const running = { status: "running" } as const;
const frame = (state: DiffUpdateState | null): DiffUpdateFrame => ({ type: "diff-update", state });

describe("差分更新の状態フレーム", () => {
  it("同じFeedStateの系列で動作中→一時停止→再開→終了を受け、既存マップと字幕を保持する", () => {
    let state = applyFrame(createFeedState(), snapshot);
    state = applyFrame(state, { type: "speaking", track: "相手", text: "続いている字幕" });
    state = applyFrame(state, { type: "intake", status: "interrupted" });
    state = applyFrame(state, { type: "screen-notice", text: "共有画面は使っていません" });
    for (const status of [running, paused, running, null]) {
      state = applyFrame(state, frame(status));
      expect(state).toMatchObject({ diffUpdate: status });
      expect(state.snapshot).toEqual(snapshot);
      expect(state.speaking).toEqual({ 相手: "続いている字幕", 自分: "" });
      expect(state.intake).toBe("interrupted");
      expect(state.screenNotice).toBe("共有画面は使っていません");
    }
  });
});

describe("AppからSessionViewへの一時停止表示", () => {
  it("一時停止の間だけ指定文を表示し、平常時・再開後・終了後は表示しない", () => {
    const feed = { ...createFeedState(), snapshot, speaking: { 相手: "続いている字幕", 自分: "" } };
    const render = (diffUpdate: typeof paused | typeof running | null) => {
      useLiveFeed.mockReturnValue({ ...feed, diffUpdate });
      return renderToStaticMarkup(<App />);
    };
    expect(render(running)).not.toContain(message);
    const shown = render(paused);
    expect(shown).toContain(message);
    expect(shown).toContain("続いている字幕");
    expect(shown).toContain("map-view-stub");
    expect(render(running)).not.toContain(message);
    expect(render(null)).not.toContain(message);
  });

});
