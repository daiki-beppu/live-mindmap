// PROTOTYPE（issue #131）: 長い会議の画面の試作。main には入れない。
//   sh web/src/prototype-long-meeting/prepare.sh <longMeetingProto の出力> parnassus
//   pnpm -C web dev → http://localhost:5173/prototype-long-meeting.html?variant=A&camera=focus&hint=text&sample=parnassus&min=90
// 試作の出力のログを再生し、各反映の時点のマップを、今の画面（右の列つき）の中で 3 案に描き分ける。
import { StrictMode, useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChangeList } from "../ChangeList.tsx";
import { EvidencePanel } from "../EvidencePanel.tsx";
import { evidenceOf } from "../evidence.ts";
import "../styles.css";
import { clock, foldedIds, frameAt, loadMeeting, topicOf, type Meeting } from "./data.ts";
import type { Camera, Hint } from "./ProtoCanvas.tsx";
import "./proto.css";
import { VARIANTS, type VariantKey } from "./variants.tsx";

const params = new URLSearchParams(location.search);
const setParam = (k: string, v: string) => {
  params.set(k, v);
  history.replaceState(null, "", `?${params}`);
};
const KEYS = Object.keys(VARIANTS) as VariantKey[];
const CAMERAS: Camera[] = ["focus", "glance", "fit"];
const CAMERA_NAME: Record<Camera, string> = { focus: "今の議題に寄る", glance: "議題が変わったら全体→寄る", fit: "常に全体（今の作り）" };
const HINTS: Hint[] = ["text", "count", "none"];
const HINT_NAME: Record<Hint, string> = { text: "中身の手がかり（文字）", count: "隠れた数（Drawnix 風）", none: "議題名だけ" };

function App() {
  const [sample, setSample] = useState(params.get("sample") ?? "parnassus");
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [index, setIndex] = useState(0);
  const [variant, setVariant] = useState<VariantKey>((params.get("variant") as VariantKey) ?? "A");
  const [camera, setCamera] = useState<Camera>((params.get("camera") as Camera) ?? "focus");
  const [nested, setNested] = useState(params.get("nest") === "1");
  const [runs, setRuns] = useState(params.get("runs") !== "0");
  const [hint, setHint] = useState<Hint>((params.get("hint") as Hint) ?? "text");
  const [playing, setPlaying] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null); // 選択・目次で見ている議題（次の反映で今の議題に戻る）

  useEffect(() => {
    void loadMeeting(sample).then((m) => {
      setMeeting(m);
      const min = Number(params.get("min") ?? "60");
      const i = m.diffAt.findLastIndex((a) => a <= min * 60);
      setIndex(Math.max(0, i));
    });
  }, [sample]);

  useEffect(() => {
    if (!playing || !meeting) return;
    const t = setInterval(() => setIndex((i) => Math.min(meeting.diffEnds.length - 1, i + 1)), Number(params.get("speed") ?? "1500"));
    return () => clearInterval(t);
  }, [playing, meeting]);

  const frame = useMemo(() => (meeting ? frameAt(meeting, index, nested) : null), [meeting, index, nested]);

  // 反映で何か変わったら、選択で見ていた議題から今の議題に戻る
  useEffect(() => {
    if (frame && frame.snapshot.changes.some((c) => c.round === frame.snapshot.round)) setPinned(null);
  }, [frame]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        const d = e.key === "ArrowRight" ? 1 : -1;
        if (e.shiftKey) setIndex((i) => Math.max(0, Math.min((meeting?.diffEnds.length ?? 1) - 1, i + d)));
        else
          setVariant((v) => {
            const n = KEYS[(KEYS.indexOf(v) + d + KEYS.length) % KEYS.length]!;
            setParam("variant", n);
            return n;
          });
      }
      if (e.key === " ") {
        e.preventDefault();
        setPlaying((p) => !p);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [meeting]);

  const byId = useMemo(() => new Map(frame?.snapshot.nodes.map((n) => [n.id, n]) ?? []), [frame]);
  const onSelect = useCallback(
    (id: string) => {
      setSelectedId(id);
      const t = topicOf(byId, id);
      if (t) setPinned(t);
    },
    [byId],
  );

  if (!meeting || !frame) return <p className="waiting">素材を読み込んでいます</p>;
  const focusTopic = pinned ?? frame.current;
  // 選択で見ている議題と、その祖先を開く
  const opened = new Set<string>();
  for (let cur: string | null | undefined = pinned; cur && cur !== "root"; cur = byId.get(cur)?.parent) opened.add(cur);
  const folded = foldedIds(frame, opened);
  const V = VARIANTS[variant].C;
  const topics = frame.snapshot.nodes.filter((n) => n.kind === "議題");
  const openCount = topics.filter((t) => !frame.closed.has(t.id)).length;
  const jump = (min: number) => setIndex(Math.max(0, meeting.diffAt.findLastIndex((a) => a <= min * 60)));
  const last = meeting.diffEnds.length - 1;

  return (
    <>
      <div className="layout">
        <div className="map">
          <V
            frame={frame}
            folded={folded}
            focusTopic={focusTopic}
            hint={hint}
            camera={camera}
            selectedId={selectedId}
            onSelect={onSelect}
            onPickTopic={setPinned}
            runs={runs}
          />
        </div>
        <div className="side">
          <EvidencePanel selectedId={selectedId} evidence={selectedId === null ? null : evidenceOf(frame.snapshot, selectedId)} />
          <ChangeList changes={frame.snapshot.changes.slice(-200)} onSelect={onSelect} />
        </div>
      </div>
      <div className="proto-bar">
        <select value={sample} onChange={(e) => (setSample(e.target.value), setParam("sample", e.target.value))}>
          <option value="parnassus">parnassus 161 分</option>
          <option value="silly">silly 76 分</option>
        </select>
        <button type="button" onClick={() => setVariant((v) => { const n = KEYS[(KEYS.indexOf(v) + KEYS.length - 1) % KEYS.length]!; setParam("variant", n); return n; })}>←</button>
        <strong>
          {variant} {VARIANTS[variant].name}
        </strong>
        <button type="button" onClick={() => setVariant((v) => { const n = KEYS[(KEYS.indexOf(v) + 1) % KEYS.length]!; setParam("variant", n); return n; })}>→</button>
        <select value={camera} onChange={(e) => (setCamera(e.target.value as Camera), setParam("camera", e.target.value))}>
          {CAMERAS.map((c) => (
            <option key={c} value={c}>
              {CAMERA_NAME[c]}
            </option>
          ))}
        </select>
        <select value={hint} onChange={(e) => (setHint(e.target.value as Hint), setParam("hint", e.target.value))}>
          {HINTS.map((h) => (
            <option key={h} value={h}>
              {HINT_NAME[h]}
            </option>
          ))}
        </select>
        <label>
          <input type="checkbox" checked={nested} onChange={(e) => (setNested(e.target.checked), setParam("nest", e.target.checked ? "1" : "0"))} />
          入れ子の議題
        </label>
        <label>
          <input type="checkbox" checked={runs} onChange={(e) => (setRuns(e.target.checked), setParam("runs", e.target.checked ? "1" : "0"))} />
          済みの並びをまとめる
        </label>
        <span className="proto-bar__sep" />
        <button type="button" onClick={() => setPlaying((p) => !p)}>{playing ? "■" : "▶"}</button>
        <button type="button" onClick={() => setIndex((i) => Math.max(0, i - 1))}>−1</button>
        <input type="range" min={0} max={last} value={index} onChange={(e) => setIndex(Number(e.target.value))} />
        <button type="button" onClick={() => setIndex((i) => Math.min(last, i + 1))}>+1</button>
        {[60, 90, 120].map((m) => (
          <button key={m} type="button" onClick={() => jump(m)}>
            {m}
          </button>
        ))}
        <button type="button" onClick={() => setIndex(last)}>終</button>
        <span className="proto-bar__info">
          {clock(frame.at)}・議題 {topics.length}（話し中 {openCount}）・ノード {frame.snapshot.nodes.length - 1}・今の議題「{byId.get(frame.current ?? "")?.text ?? "-"}」
        </span>
      </div>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
