// PROTOTYPE（issue #383）: ローカルモードであることの画面での見せ方の 4 案。main には入れない。
//   pnpm -C web dev → http://localhost:5173/prototype-model-select.html?variant=A&state=apple
// 画面はライブと同じ SessionView（偽のスナップショット）にし、ローカルモードの表示だけを ?variant= で切り替える。
// ?state= で差分更新のモデルの状態を切り替える（下のバーの左右の矢印・状態のボタン、キーは ← → と 1〜5）。
//   A 左下の帯の右端: 「動かしています」の帯（下端 4〜20px）の右端に、常に一文を置く。異常も同じ場所で文を差し替える
//   B 右の列の最上段: 根拠の上に 1 行を足す（最初からある行なので跳ばない）。E で列を隠すと消える。異常は字幕の横（取り込みの一言の場所）
//   C 窓の上端の細い線: 窓の上端に 2px の線と、左上に小さな文字。遠目にも分かる。異常は線の色と文字で
//   D 画面には出さない: タブの名前だけを変える。異常は字幕の横（取り込みの一言の場所）
// いずれも位置は absolute で、出し入れしても字幕・マップは動かない。影・バッジは付けない。
import { StrictMode, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Snapshot } from "../../../server/src/core/index.ts";
import type { Speaking } from "../liveFeed.ts";
import { SessionView } from "../SessionView.tsx";
import "../styles.css";
import "./proto.css";

const params = new URLSearchParams(location.search);
const setParam = (k: string, v: string) => {
  params.set(k, v);
  history.replaceState(null, "", `?${params}`);
};

type VariantKey = "A" | "B" | "C" | "D";
const VARIANTS: Record<VariantKey, string> = {
  A: "左下の帯の右端",
  B: "右の列の最上段",
  C: "窓の上端の細い線",
  D: "画面には出さない（タブの名前だけ）",
};
const KEYS = Object.keys(VARIANTS) as VariantKey[];

// 差分更新のモデルの状態。local の 2 つが平常、restarting・stopped は子プロセスが落ちたとき（#379 の 5）
type State = "claude" | "apple" | "builtin" | "restarting" | "stopped";
const STATES: Record<State, string> = {
  claude: "通常（Claude）",
  apple: "ローカル・Apple Intelligence",
  builtin: "ローカル・内蔵",
  restarting: "ローカル・立ち上げ直し中",
  stopped: "ローカル・更新を止めた",
};
const STATE_KEYS = Object.keys(STATES) as State[];

// 状態ごとの文。mode は常に出す一文、trouble は異常のときだけの一文
function textsOf(state: State): { mode: string | null; trouble: string | null } {
  switch (state) {
    case "claude":
      return { mode: null, trouble: null };
    case "apple":
      return { mode: "ローカルモード・Apple Intelligence", trouble: null };
    case "builtin":
      return { mode: "ローカルモード・内蔵のモデル（Qwen3.5-4B）", trouble: null };
    case "restarting":
      return { mode: "ローカルモード・Apple Intelligence", trouble: "マップの更新を再開しています" };
    case "stopped":
      return { mode: "ローカルモード・Apple Intelligence", trouble: "マップの更新が止まっています" };
  }
}

function VariantA({ state }: { state: State }) {
  const { mode, trouble } = textsOf(state);
  if (mode === null) return null;
  return <p className="proto-a">{trouble === null ? mode : `${mode}・${trouble}`}</p>;
}

function VariantB({ state }: { state: State }) {
  const { mode, trouble } = textsOf(state);
  return (
    <>
      {mode !== null && <p className="proto-b">{mode}</p>}
      {trouble !== null && <div className="intake-notice proto-trouble">{trouble}</div>}
    </>
  );
}

function VariantC({ state }: { state: State }) {
  const { mode, trouble } = textsOf(state);
  if (mode === null) return null;
  const tone = state === "stopped" ? "stopped" : state === "restarting" ? "restarting" : "ok";
  return (
    <>
      <div className={`proto-c-line proto-c-line--${tone}`} />
      <p className="proto-c-text">{trouble === null ? mode : `${mode}・${trouble}`}</p>
    </>
  );
}

function VariantD({ state }: { state: State }) {
  const { mode, trouble } = textsOf(state);
  useEffect(() => {
    document.title = mode === null ? "live-mindmap" : "ローカルモード・live-mindmap";
    return () => {
      document.title = "live-mindmap";
    };
  }, [mode]);
  return trouble === null ? null : <div className="intake-notice proto-trouble">{trouble}</div>;
}

const RENDER: Record<VariantKey, (p: { state: State }) => ReactNode> = { A: VariantA, B: VariantB, C: VariantC, D: VariantD };

function Switcher({ variant, state, onVariant, onState }: { variant: VariantKey; state: State; onVariant: (v: VariantKey) => void; onState: (s: State) => void }) {
  const step = (d: number) => onVariant(KEYS[(KEYS.indexOf(variant) + d + KEYS.length) % KEYS.length]!);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "ArrowLeft" && e.altKey) step(-1);
      else if (e.key === "ArrowRight" && e.altKey) step(1);
      else if (/^[1-5]$/.test(e.key)) onState(STATE_KEYS[Number(e.key) - 1]!);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  });
  return (
    <div className="proto-switcher">
      <div className="proto-switcher__row">
        <button onClick={() => step(-1)}>←</button>
        <span>
          {variant}（{VARIANTS[variant]}）
        </span>
        <button onClick={() => step(1)}>→</button>
      </div>
      <div className="proto-switcher__row">
        {STATE_KEYS.map((s, i) => (
          <button key={s} className={s === state ? "is-on" : ""} onClick={() => onState(s)}>
            {i + 1} {STATES[s]}
          </button>
        ))}
      </div>
      <div className="proto-switcher__hint">案は Alt+← →、状態は 1〜5。E で右の列、C で字幕を出し入れできる</div>
    </div>
  );
}

// 偽の会議（採用の定例）。根拠の発言は 1 つだけ持たせる
const snapshot: Snapshot = {
  nodes: [
    { id: "root", parent: null, kind: "会議", text: "採用の定例", evidence: [] },
    { id: "t1", parent: "root", kind: "議題", text: "中途採用の面接の進め方", evidence: ["r1"] },
    { id: "p1", parent: "t1", kind: "論点", text: "面接は何回にするか", evidence: ["r1"], pointStatus: "決定済み" },
    { id: "a1", parent: "p1", kind: "案", text: "一次をカジュアル面談にして 2 回", evidence: ["r1"] },
    { id: "d1", parent: "p1", kind: "決定", text: "面接は 2 回（一次はカジュアル面談）", evidence: ["r1"] },
    { id: "p2", parent: "t1", kind: "論点", text: "課題の提出を求めるか", evidence: ["r1"], pointStatus: "未決" },
    { id: "k1", parent: "p2", kind: "課題", text: "候補者の負担が大きい", evidence: ["r1"] },
    { id: "t2", parent: "root", kind: "議題", text: "求人票の見直し", evidence: ["r1"] },
    { id: "s1", parent: "t2", kind: "要点", text: "リモート可を明記する", evidence: ["r1"] },
    { id: "o1", parent: "t2", kind: "TODO", text: "求人票の文面を来週までに直す（佐藤）", evidence: ["r1"] },
  ],
  round: 6,
  changes: [
    { round: 5, at: 812, change: "追加", node: "d1", kind: "決定", text: "面接は 2 回（一次はカジュアル面談）" },
    { round: 6, at: 905, change: "追加", node: "o1", kind: "TODO", text: "求人票の文面を来週までに直す（佐藤）" },
  ],
  remarks: [{ id: "r1", track: "相手", start: 800, end: 806, text: "一次はカジュアル面談にして、全部で 2 回にしましょう" }],
  currentTopic: "t2",
  lastChanged: "o1",
  now: 910,
};
const speaking: Speaking = { 相手: "求人票はリモート可をはっきり書いた方がいいですね。", 自分: "" };

function Proto() {
  const [variant, setVariant] = useState<VariantKey>(KEYS.includes(params.get("variant") as VariantKey) ? (params.get("variant") as VariantKey) : "A");
  const [state, setState] = useState<State>(STATE_KEYS.includes(params.get("state") as State) ? (params.get("state") as State) : "apple");
  const Indicator = RENDER[variant];
  return (
    <div className={`proto-root proto-root--${variant}`}>
      <SessionView snapshot={snapshot} speaking={speaking} intake="running" />
      <Indicator state={state} />
      <Switcher
        variant={variant}
        state={state}
        onVariant={(v) => {
          setVariant(v);
          setParam("variant", v);
        }}
        onState={(s) => {
          setState(s);
          setParam("state", s);
        }}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Proto />
  </StrictMode>,
);
