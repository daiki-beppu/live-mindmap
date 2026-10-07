import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Snapshot } from "../../server/src/core/index.ts";
import { intakeNoticeText, type IntakeStatus } from "../src/intake.ts";
import type { Speaking } from "../src/liveFeed.ts";
import { SessionView } from "../src/SessionView.tsx";

// useIntakeNotice は useSyncExternalStore を使い、サーバー側の描画（renderToStaticMarkup）では
// getServerSnapshot が無く例外になる。web のテスト環境にはレンダラが無いため、hook は
// 「現在の状態から文を決める本物の規則（intakeNoticeText）」を通す置き換えにする。
const useIntakeNotice = vi.hoisted(() => vi.fn());
vi.mock("../src/useIntakeNotice.ts", () => ({ useIntakeNotice }));
// React Flow はサーバー側の描画の対象外。マップそのものはこのテストの契約ではない
const mapViewProps = vi.hoisted(() => vi.fn());
vi.mock("../src/MapView.tsx", () => ({
  MapView: (props: unknown) => {
    mapViewProps(props);
    return <div className="map-view-stub" />;
  },
}));

const snapshot: Snapshot = {
  nodes: [
    { id: "root", parent: null, kind: "会議", text: "定例", evidence: [] },
    { id: "n1", parent: "root", kind: "論点", text: "面接は何回か", evidence: ["r1"], pointStatus: "未決" },
  ],
  round: 1,
  changes: [{ round: 1, at: 19.2, change: "追加", node: "n1", kind: "論点", text: "面接は何回か" }],
  remarks: [{ id: "r1", track: "相手", start: 10, end: 15, text: "何回にしますか" }],
};
const speaking: Speaking = { 相手: "次の質問です。", 自分: "" };

beforeEach(() => {
  useIntakeNotice.mockReset();
  mapViewProps.mockReset();
  useIntakeNotice.mockImplementation((status: IntakeStatus) => intakeNoticeText({ previous: null, current: status, msSinceChange: 0 }));
});

describe("SessionView: スナップショット・字幕の内容・取り込みの状態だけで描くライブの画面", () => {
  it("マップ・字幕・右の列（根拠と変わったこと）を、渡されたスナップショットと発言から描く", () => {
    const html = renderToStaticMarkup(<SessionView snapshot={snapshot} speaking={speaking} />);
    expect(html).toContain("map-view-stub");
    expect(html).toContain("次の質問です。");
    expect(html).toContain("根拠");
    expect(html).toContain("ノードを選ぶと、根拠の発言が出ます");
    expect(html).toContain("変わったこと");
    expect(html).toContain("面接は何回か");
  });

  it("class 名の入れ子は layout > (map, side) を保つ", () => {
    const html = renderToStaticMarkup(<SessionView snapshot={snapshot} speaking={speaking} />);
    expect(html).toMatch(/^<div class="layout"><div class="map">[\s\S]*<\/div><div class="side">[\s\S]*<\/div><\/div>$/);
    const mapPart = html.slice(html.indexOf('class="map"'), html.indexOf('class="side"'));
    expect(mapPart).toContain("captions");
    expect(html.slice(html.indexOf('class="side"'))).toContain("evidence");
  });

  it("待ち表示（サーバーを待っています）は出さない（ライブの入口だけの表示）", () => {
    const html = renderToStaticMarkup(<SessionView snapshot={snapshot} speaking={speaking} />);
    expect(html).not.toContain("サーバーを待っています");
  });
});

describe("SessionView: 取り込みの状態の知らせは、渡したときだけ出る", () => {
  it("取り込みの状態を渡さなければ、知らせは出ず、知らせの仕組みも動かさない", () => {
    const html = renderToStaticMarkup(<SessionView snapshot={snapshot} speaking={speaking} />);
    expect(html).not.toContain("intake-notice");
    expect(useIntakeNotice).not.toHaveBeenCalled();
  });

  it("interrupted を渡すと、途切れの知らせが出る", () => {
    const html = renderToStaticMarkup(<SessionView snapshot={snapshot} speaking={speaking} intake="interrupted" />);
    expect(html).toContain("intake-notice");
    expect(html).toContain("音声の取り込みが途切れました。再開しています");
    expect(useIntakeNotice).toHaveBeenCalledWith("interrupted");
  });

  it("stopped を渡すと、止まっている知らせが出る", () => {
    const html = renderToStaticMarkup(<SessionView snapshot={snapshot} speaking={speaking} intake="stopped" />);
    expect(html).toContain("音声の取り込みが止まっています");
  });

  it("running を渡した場合は、渡したうえで知らせの文がないので何も出ない（省略とは別の経路）", () => {
    const html = renderToStaticMarkup(<SessionView snapshot={snapshot} speaking={speaking} intake="running" />);
    expect(html).not.toContain("intake-notice");
    expect(useIntakeNotice).toHaveBeenCalledWith("running");
  });
});

describe("SessionView: 見る状態（動かしている間の左下の文字）", () => {
  it("初期状態は自動で、左下の文字は出ない", () => {
    const html = renderToStaticMarkup(<SessionView snapshot={snapshot} speaking={speaking} />);
    expect(html).not.toContain("viewing-notice");
  });

  it("マップに、見る状態・カメラへの指示・出来事の通知先を渡す（初期は自動）", () => {
    renderToStaticMarkup(<SessionView snapshot={snapshot} speaking={speaking} />);
    const props = mapViewProps.mock.calls[0]![0] as { viewing: unknown; onViewingEvent: unknown; camera: unknown };
    expect(props.viewing).toEqual({ mode: "auto" });
    expect(typeof props.onViewingEvent).toBe("function");
    expect(props.camera).toBeDefined();
  });
});
