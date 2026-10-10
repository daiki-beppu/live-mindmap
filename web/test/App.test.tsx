import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "../../server/src/core/index.ts";
import type { FeedState } from "../src/liveFeed.ts";
import { App } from "../src/App.tsx";

// Issue #280: useLiveFeed の screenNotice が、App を通って実際の SessionView の表示（出す・消す）まで届く。
// 接続（WebSocket）は持たないので useLiveFeed を置き換える。map と取り込みの一言の hook はサーバー側の描画の対象外なので置き換える
const useLiveFeed = vi.hoisted(() => vi.fn());
vi.mock("../src/useLiveFeed.ts", () => ({ useLiveFeed }));
vi.mock("../src/useIntakeNotice.ts", () => ({ useIntakeNotice: () => null }));
vi.mock("../src/MapView.tsx", () => ({ MapView: () => <div className="map-view-stub" /> }));

const snapshot: Snapshot = { nodes: [], round: 0, changes: [], remarks: [] };
const feed = (screenNotice: string | null): FeedState => ({ snapshot, speaking: { 相手: "", 自分: "" }, intake: "running", screenNotice, diffUpdate: null, local: false });

describe("App: 共有画面を使っていない一文は、useLiveFeed の値から表示・消去まで届く", () => {
  beforeEach(() => useLiveFeed.mockReset());

  it("screenNotice の文があれば画面に出て、null なら出ない", () => {
    const text = "共有画面は使っていません（画面収録の許可がありません）";
    useLiveFeed.mockReturnValue(feed(text));
    const shown = renderToStaticMarkup(<App />);
    expect(shown).toContain("screen-notice");
    expect(shown).toContain(text);

    useLiveFeed.mockReturnValue(feed(null));
    expect(renderToStaticMarkup(<App />)).not.toContain("screen-notice");
  });

  it("feed の local が SessionView の線と文字の表示へ届く", () => {
    useLiveFeed.mockReturnValue({ ...feed(null), local: true });
    const shown = renderToStaticMarkup(<App />);
    expect(shown).toContain("ローカルモード・Apple Intelligence");
    useLiveFeed.mockReturnValue(feed(null));
    expect(renderToStaticMarkup(<App />)).not.toContain("ローカルモード・Apple Intelligence");
  });

  it.each([
    ["restarting", "ローカルモード・Apple Intelligence・マップの更新を再開しています"],
    ["stopped", "ローカルモード・Apple Intelligence・マップの更新が止まっています"],
  ] as const)("feed の %s が SessionView を経てローカルモードの文言へ届く", (status, text) => {
    useLiveFeed.mockReturnValue({ ...feed(null), local: true, diffUpdate: { status } });
    expect(renderToStaticMarkup(<App />)).toContain(text);
  });
});
