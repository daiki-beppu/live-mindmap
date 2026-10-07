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

// start から始まる div の開きタグから、対応する閉じタグまでを切り出す
function balancedDiv(html: string, start: number): string {
  let depth = 0;
  for (const m of html.slice(start).matchAll(/<div\b|<\/div>/g)) {
    depth += m[0] === "</div>" ? -1 : 1;
    if (depth === 0) return html.slice(start, start + m.index! + m[0].length);
  }
  throw new Error("div が閉じていない");
}

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

  it("class 名の入れ子は layout > (map, side) を保ち、字幕は map の外（layout の直下）に出る", () => {
    const html = renderToStaticMarkup(<SessionView snapshot={snapshot} speaking={speaking} />);
    expect(html.startsWith('<div class="layout">')).toBe(true);
    const mapStart = html.indexOf('<div class="map">');
    const mapPart = balancedDiv(html, mapStart);
    expect(mapPart).toContain("map-view-stub");
    expect(mapPart).not.toContain("captions");
    const outside = html.slice(0, mapStart) + html.slice(mapStart + mapPart.length);
    expect(outside).toContain("captions");
    expect(outside).toContain('class="side"');
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

  it("初期状態では、キー一覧は出ない（常には出さない）", () => {
    const html = renderToStaticMarkup(<SessionView snapshot={snapshot} speaking={speaking} />);
    expect(html).not.toContain("key-list");
  });

  it("キー一覧を開いた状態では、一覧はマップの区画に出て、右の列には出ない", async () => {
    // 静的描画ではキーを押せないため、初期状態だけをこのテストの中で開いた状態にする
    vi.resetModules();
    vi.doMock("../src/viewing.ts", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../src/viewing.ts")>()),
      INITIAL_VIEWING: { mode: "auto", keyList: true },
    }));
    try {
      const { SessionView: OpenedSessionView } = await import("../src/SessionView.tsx");
      const html = renderToStaticMarkup(<OpenedSessionView snapshot={snapshot} speaking={speaking} />);
      const mapPart = html.slice(html.indexOf('class="map"'), html.indexOf('class="side"'));
      expect(mapPart).toContain('class="key-list"');
      expect(html.slice(html.indexOf('class="side"'))).not.toContain("key-list");
    } finally {
      vi.doUnmock("../src/viewing.ts");
      vi.resetModules();
    }
  });

  it("マップに、見る状態・カメラへの指示・出来事の通知先を渡す（初期は自動）", () => {
    renderToStaticMarkup(<SessionView snapshot={snapshot} speaking={speaking} />);
    const props = mapViewProps.mock.calls[0]![0] as { viewing: unknown; onViewingEvent: unknown; camera: unknown };
    expect(props.viewing).toEqual({ mode: "auto" });
    expect(typeof props.onViewingEvent).toBe("function");
    expect(props.camera).toBeDefined();
  });
});

describe("SessionView: E で右の列、C で字幕を隠した状態", () => {
  const renderWith = async (initial: Record<string, unknown>, intake?: IntakeStatus) => {
    // 静的描画ではキーを押せないため、初期状態だけをこのテストの中で隠した状態にする
    vi.resetModules();
    vi.doMock("../src/viewing.ts", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../src/viewing.ts")>()),
      INITIAL_VIEWING: { mode: "auto", ...initial },
    }));
    try {
      const { SessionView: HiddenSessionView } = await import("../src/SessionView.tsx");
      return renderToStaticMarkup(<HiddenSessionView snapshot={snapshot} speaking={speaking} intake={intake} />);
    } finally {
      vi.doUnmock("../src/viewing.ts");
      vi.resetModules();
    }
  };

  it("初めは右の列と字幕の両方が出ている", () => {
    const html = renderToStaticMarkup(<SessionView snapshot={snapshot} speaking={speaking} />);
    expect(html).toContain('class="side"');
    expect(html).toContain("captions");
  });

  it("右の列を隠すと、列を描かない（根拠・変わったことが出ない）。マップと字幕は残る", async () => {
    const html = await renderWith({ sideHidden: true });
    expect(html).not.toContain('class="side"');
    expect(html).not.toContain("ノードを選ぶと、根拠の発言が出ます");
    expect(html).not.toContain("変わったこと");
    expect(html).toContain("map-view-stub");
    expect(html).toContain("次の質問です。");
  });

  it("字幕を隠すと、字幕が出ない。右の列とマップは残る", async () => {
    const html = await renderWith({ captionsHidden: true });
    expect(html).not.toContain("次の質問です。");
    expect(html).not.toContain("captions");
    expect(html).toContain('class="side"');
    expect(html).toContain("map-view-stub");
  });

  it("字幕を隠しても、取り込みの一言と左下の文字（見る状態）は隠れない", async () => {
    const html = await renderWith({ captionsHidden: true, mode: "manual", topic: undefined }, "interrupted");
    expect(html).not.toContain("次の質問です。");
    expect(html).toContain("intake-notice");
    expect(html).toContain("音声の取り込みが途切れました。再開しています");
    expect(html).toContain("viewing-notice");
  });

  it("両方隠しても、右の列と字幕だけが消え、マップと取り込みの一言は描かれる", async () => {
    const html = await renderWith({ sideHidden: true, captionsHidden: true }, "stopped");
    expect(html).not.toContain('class="side"');
    expect(html).not.toContain("captions");
    expect(html).toContain("intake-notice");
    expect(html).toContain("map-view-stub");
  });
});

describe("SessionView: 選択は見る状態から描く（根拠の欄と、マップへ渡す選択）", () => {
  const renderWith = async (initial: Record<string, unknown>) => {
    // 静的描画ではキーを押せないため、初期状態だけをこのテストの中で選んだ状態にする
    vi.resetModules();
    vi.doMock("../src/viewing.ts", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../src/viewing.ts")>()),
      INITIAL_VIEWING: { mode: "auto", ...initial },
    }));
    try {
      const { SessionView: SelectedSessionView } = await import("../src/SessionView.tsx");
      return renderToStaticMarkup(<SelectedSessionView snapshot={snapshot} speaking={speaking} />);
    } finally {
      vi.doUnmock("../src/viewing.ts");
      vi.resetModules();
    }
  };
  const sideOf = (html: string) => html.slice(html.indexOf('class="side"'));

  it("選んでいなければ、マップへ渡す選択は無く、根拠の欄は案内を出す", () => {
    renderToStaticMarkup(<SessionView snapshot={snapshot} speaking={speaking} />);
    const props = mapViewProps.mock.calls[0]![0] as { selectedId: unknown };
    expect(props.selectedId).toBeNull();
  });

  it("見る状態の選択（キーで選んだもの）が、根拠の欄とマップへ渡す選択の両方に出る", async () => {
    const html = await renderWith({ selection: { id: "n1", byKey: true } });
    expect(sideOf(html)).toContain("何回にしますか");
    expect(sideOf(html)).not.toContain("ノードを選ぶと、根拠の発言が出ます");
    const props = mapViewProps.mock.calls.at(-1)![0] as { selectedId: unknown };
    expect(props.selectedId).toBe("n1");
  });

  it("クリックで選んだもの（byKey: false）も同じ選択として描かれる", async () => {
    const html = await renderWith({ selection: { id: "n1", byKey: false } });
    expect(sideOf(html)).toContain("何回にしますか");
    expect((mapViewProps.mock.calls.at(-1)![0] as { selectedId: unknown }).selectedId).toBe("n1");
  });

  it("ルートを選んだときも、マップへ渡す選択になり、根拠の欄は案内ではなく選んだ状態で出て、変わったことは下に出たまま", async () => {
    const html = await renderWith({ selection: { id: "root", byKey: true } });
    expect((mapViewProps.mock.calls.at(-1)![0] as { selectedId: unknown }).selectedId).toBe("root");
    expect(sideOf(html)).not.toContain("ノードを選ぶと、根拠の発言が出ます");
    expect(sideOf(html)).toContain("変わったこと");
  });

  it("右の列を隠していれば、選択があっても列は出ない（選択が列を出さない）。マップへの選択は渡る", async () => {
    const html = await renderWith({ sideHidden: true, selection: { id: "n1", byKey: true } });
    expect(html).not.toContain('class="side"');
    expect(html).not.toContain("何回にしますか");
    expect((mapViewProps.mock.calls.at(-1)![0] as { selectedId: unknown }).selectedId).toBe("n1");
  });
});

describe("SessionView: 見返しの外枠（review.frame）に、見る状態と出し入れの関数を渡す", () => {
  type Overlay = { captionsHidden: boolean; sideHidden: boolean; onCaptions: () => void; onSide: () => void };
  const renderReview = async (initial: Record<string, unknown> = {}) => {
    // 静的描画ではキーを押せないため、初期状態だけをこのテストの中で差し替える
    vi.resetModules();
    vi.doMock("../src/viewing.ts", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../src/viewing.ts")>()),
      INITIAL_VIEWING: { mode: "auto", ...initial },
    }));
    try {
      const { SessionView: ReviewSessionView } = await import("../src/SessionView.tsx");
      const overlays: Overlay[] = [];
      const sessions: unknown[] = [];
      const frame = vi.fn((session: unknown, overlay: Overlay) => {
        sessions.push(session);
        overlays.push(overlay);
        return (
          <div className="frame-stub">
            {session as never}
            <span className="frame-bar" />
          </div>
        );
      });
      const html = renderToStaticMarkup(<ReviewSessionView snapshot={snapshot} speaking={speaking} review={{ timeMoves: 0, frame }} />);
      return { html, frame, overlays, sessions };
    } finally {
      vi.doUnmock("../src/viewing.ts");
      vi.resetModules();
    }
  };

  it("frame が返したものを描き、その中に今までの画面（layout）が入る", async () => {
    const { html, frame } = await renderReview();
    expect(frame).toHaveBeenCalled();
    expect(html.startsWith('<div class="frame-stub">')).toBe(true);
    expect(html).toContain('<div class="layout">');
    expect(html).toContain("frame-bar");
    expect(html).toContain("map-view-stub");
    expect(html).toContain("次の質問です。");
  });

  it("初めは字幕・右の列とも隠れていない。出し入れの関数を 2 つ受け取る", async () => {
    const { overlays } = await renderReview();
    const overlay = overlays.at(-1)!;
    expect(overlay.captionsHidden).toBe(false);
    expect(overlay.sideHidden).toBe(false);
    expect(typeof overlay.onCaptions).toBe("function");
    expect(typeof overlay.onSide).toBe("function");
  });

  it("見る状態で字幕を隠していれば captionsHidden が true（状態は SessionView だけが持つ）", async () => {
    const { overlays, html } = await renderReview({ captionsHidden: true });
    expect(overlays.at(-1)).toMatchObject({ captionsHidden: true, sideHidden: false });
    expect(html).not.toContain("次の質問です。");
  });

  it("見る状態で右の列を隠していれば sideHidden が true", async () => {
    const { overlays, html } = await renderReview({ sideHidden: true });
    expect(overlays.at(-1)).toMatchObject({ captionsHidden: false, sideHidden: true });
    expect(html).not.toContain('class="side"');
  });

  it("両方隠していれば、両方 true", async () => {
    const { overlays } = await renderReview({ captionsHidden: true, sideHidden: true });
    expect(overlays.at(-1)).toMatchObject({ captionsHidden: true, sideHidden: true });
  });

  it("frame を渡さない見返し（timeMoves だけ）と、review なしのライブは、これまでどおり layout で始まる", () => {
    const withoutFrame = renderToStaticMarkup(<SessionView snapshot={snapshot} speaking={speaking} review={{ timeMoves: 0 }} />);
    const live = renderToStaticMarkup(<SessionView snapshot={snapshot} speaking={speaking} />);
    expect(withoutFrame.startsWith('<div class="layout">')).toBe(true);
    expect(live.startsWith('<div class="layout">')).toBe(true);
  });
});

describe("SessionView: ? のキー一覧は、見返しのときだけ見返しのキーを載せる", () => {
  const renderOpened = async (review: boolean) => {
    vi.resetModules();
    vi.doMock("../src/viewing.ts", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../src/viewing.ts")>()),
      INITIAL_VIEWING: { mode: "auto", keyList: true },
    }));
    try {
      const { SessionView: OpenedSessionView } = await import("../src/SessionView.tsx");
      return renderToStaticMarkup(<OpenedSessionView snapshot={snapshot} speaking={speaking} review={review ? { timeMoves: 0 } : undefined} />);
    } finally {
      vi.doUnmock("../src/viewing.ts");
      vi.resetModules();
    }
  };

  it("見返しでは、一覧に Space・K / J / L / Home / End などが載る", async () => {
    const html = await renderOpened(true);
    const list = html.slice(html.indexOf('class="key-list"'), html.indexOf('class="side"'));
    for (const keys of ["Space・K", "J / L", ", / .", "&lt; / &gt;", "Home / End"]) expect(list).toContain(keys);
  });

  it("ライブでは、同じ一覧に見返しのキーは載らない", async () => {
    const html = await renderOpened(false);
    expect(html).toContain('class="key-list"');
    for (const keys of ["Space・K", "J / L", "Home / End"]) expect(html).not.toContain(keys);
  });
});
