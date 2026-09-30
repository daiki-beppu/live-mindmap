// PROTOTYPE — issue #7「マップの見せ方」。本番コードではない。
// 3 つの描画ライブラリ（React Flow / markmap / Plait）で、差分更新エンジンのラン結果を再生して見比べる。
// `?variant=A|B|C` で切り替える。再生・根拠パネル・変更フィードは共通で、マップの描画だけが差し替わる。
import { useEffect, useMemo, useRef, useState } from "react";
import { buildView, CHANGE_LABEL, fmt, KIND_STYLE, listRuns, loadRun, prepare, type Prepared, type Run, type View } from "./data";
import { VariantFlow } from "./VariantFlow";
import { VariantMarkmap } from "./VariantMarkmap";
import { VariantPlait } from "./VariantPlait";
import { Switcher } from "./Switcher";

export type VariantProps = { view: View; selected: string | null; onSelect: (id: string | null) => void; showHot: boolean; autoFit: boolean };

const VARIANTS = [
  { key: "A", name: "React Flow（カード＋自前の木レイアウト）", C: VariantFlow },
  { key: "B", name: "markmap（線の上に文字）", C: VariantMarkmap },
  { key: "C", name: "Plait / Drawnix（マインドマップ編集器）", C: VariantPlait },
];

const param = (k: string, d: string) => new URLSearchParams(location.search).get(k) ?? d;

export function App() {
  const [variant, setVariant] = useState(param("variant", "A"));
  const [runs, setRuns] = useState<string[]>([]);
  const [runName, setRunName] = useState(param("run", "facilitators-meeting__claude-sonnet-5-5__batch2-v3"));
  const [run, setRun] = useState<Run | null>(null);
  const [synthetic, setSynthetic] = useState(true);
  const [showHot, setShowHot] = useState(true);
  const [autoFit, setAutoFit] = useState(true);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(20);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => { listRuns().then(setRuns); }, []);
  useEffect(() => { setRun(null); loadRun(runName).then((r) => { setRun(r); setT(0); setSelected(null); }); }, [runName]);

  const prepared: Prepared | null = useMemo(() => (run ? prepare(run, synthetic) : null), [run, synthetic]);
  const end = run ? run.steps[run.steps.length - 1]!.applyAt + 1 : 0;

  // 再生: 会議内の時刻を speed 倍で進める
  const last = useRef(performance.now());
  useEffect(() => {
    if (!playing) return;
    last.current = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const dt = (now - last.current) / 1000; last.current = now;
      setT((x) => Math.min(end, x + dt * speed));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed, end]);

  const view = useMemo(() => (prepared ? buildView(prepared, t) : null), [prepared, t]);

  const jump = (dir: 1 | -1) => {
    if (!prepared || !view) return;
    const s = prepared.run.steps;
    // 次（前）に何かが変わる反映へ飛ぶ
    let i = view.step + dir;
    while (i >= 0 && i < s.length && prepared.events[i]!.length === 0) i += dir;
    if (i < 0) setT(0);
    else if (i < s.length) setT(s[i]!.applyAt + 0.01);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input,select,textarea,[contenteditable]")) return;
      if (e.key === " ") { e.preventDefault(); setPlaying((p) => !p); }
      if (e.key === "." ) jump(1);
      if (e.key === ",") jump(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const V = VARIANTS.find((v) => v.key === variant) ?? VARIANTS[0]!;
  const segById = useMemo(() => new Map(run?.segments.map((s) => [s.id, s]) ?? []), [run]);
  const sel = selected && view?.byId[selected];
  const recentSegs = run ? run.segments.filter((s) => s.end <= t).slice(-3) : [];

  return (
    <div className="app">
      <header className="bar">
        <b>PROTOTYPE</b>
        <select value={runName} onChange={(e) => setRunName(e.target.value)}>
          {runs.map((r) => <option key={r}>{r}</option>)}
        </select>
        <button onClick={() => setPlaying((p) => !p)}>{playing ? "⏸" : "▶"}</button>
        <button onClick={() => jump(-1)} title="前の変化（,）">⏮</button>
        <button onClick={() => jump(1)} title="次の変化（.）">⏭</button>
        <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
          {[1, 5, 20, 60, 180].map((s) => <option key={s} value={s}>×{s}</option>)}
        </select>
        <input type="range" min={0} max={end} step={0.5} value={t} onChange={(e) => setT(Number(e.target.value))} style={{ flex: 1 }} />
        <span className="mono">{fmt(t)} / {fmt(end)}　反映 {view ? view.step + 1 : 0}　ノード {view ? view.nodes.length - 1 : 0}</span>
        <label><input type="checkbox" checked={synthetic} onChange={(e) => setSynthetic(e.target.checked)} />統合・移動を混ぜる</label>
        <label><input type="checkbox" checked={showHot} onChange={(e) => setShowHot(e.target.checked)} />いま話している</label>
        <label><input type="checkbox" checked={autoFit} onChange={(e) => setAutoFit(e.target.checked)} />自動フィット</label>
      </header>
      <main className="stage">
        <section className="map">
          {view ? <V.C view={view} selected={selected} onSelect={setSelected} showHot={showHot} autoFit={autoFit} /> : <p>読み込み中…</p>}
          {view && view.pendingSegs.length > 0 && showHot && <div className="pending">🎙 話し中… AI の反映待ち（{view.pendingSegs.length} 発言）</div>}
        </section>
        <aside className="side">
          {sel ? (
            <div className="panel">
              <div className="panel-h">
                <span className="kind" style={{ color: KIND_STYLE[sel.kind]!.color, background: KIND_STYLE[sel.kind]!.bg }}>{sel.kind}</span>
                {sel.status && <span className="status">{sel.status}</span>}
                <button onClick={() => setSelected(null)}>×</button>
              </div>
              <p className="sel-text">{sel.text}</p>
              <h4>根拠（{sel.evidence.length} 発言）</h4>
              {sel.evidence.map((id) => {
                const s = segById.get(id);
                return s ? (
                  <blockquote key={id} onClick={() => setT(Math.max(t, s.end))}>
                    <div className="mono">{fmt(s.start)}–{fmt(s.end)}　{s.track === "speaker" ? "相手" : s.track}</div>
                    {s.text}
                  </blockquote>
                ) : null;
              })}
            </div>
          ) : (
            <div className="panel">
              <h4>変わったこと</h4>
              {view?.feed.map((e, i) => (
                <div key={i} className={`feed ${view.step - e.step === 0 ? "now" : ""}`} onClick={() => setSelected(e.nodeId)}>
                  <span className="mono">{fmt(e.at)}</span>
                  <span className={`chg chg-${e.change}`}>{CHANGE_LABEL[e.change]}{e.synthetic ? "*" : ""}</span>
                  <span className="kind-s" style={{ color: KIND_STYLE[e.kind]?.color }}>{e.kind}</span>
                  <span className="ft">{e.text}</span>
                </div>
              ))}
              <p className="note">* は見せ方を試すために手で混ぜた操作</p>
            </div>
          )}
          <div className="panel transcript">
            <h4>直近の発言</h4>
            {recentSegs.map((s) => <p key={s.id}><span className="mono">{fmt(s.start)}</span> {s.text}</p>)}
          </div>
        </aside>
      </main>
      <Switcher variants={VARIANTS.map((v) => ({ key: v.key, name: v.name }))} current={V.key} onChange={setVariant} />
    </div>
  );
}
