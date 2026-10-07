// PROTOTYPE（issue #131）: 長い会議の画面の試作。main には入れない。
//   sh web/src/prototype-long-meeting/prepare.sh <longMeetingProto の出力> parnassus
//   pnpm -C web dev → http://localhost:5173/prototype-long-meeting.html?variant=A&camera=focus&hint=text&sample=parnassus&min=90
// 試作の出力のログを再生し、各反映の時点のマップを、今の画面（右の列つき）の中で 3 案に描き分ける。
// PROTOTYPE（issue #285）: 人が動かした後に自動のカメラへ戻る条件の 3 案を ?ret= で切り替える（← → でも）。
//   http://localhost:5173/prototype-long-meeting.html?ret=idle&sample=parnassus&min=90
//   キー: Esc 今の議題へ（選択も外す）／F 全体／= - 拡大・縮小／0 倍率 1.0／Z 選んだノードへ寄る／Shift＋矢印 移動／E 右の列／C 字幕／? キー一覧
//   試作の操作: Space 再生／[ ] 1 回分戻る・進む
//   移動: 縦横のスクロール・ドラッグ（⌘・Ctrl＋Shift＋スクロールで縦か横だけ）／ズーム: ⌘・Ctrl＋スクロール、ピンチ、⌘・Ctrl＋クリック（＋Option で縮小）／Esc: 今の議題へ戻る／F: 全体を見る
import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ChangeList } from "../ChangeList.tsx";
import { EvidencePanel } from "../EvidencePanel.tsx";
import { evidenceOf } from "../evidence.ts";
import "../styles.css";
import { clock, foldedIds, frameAt, loadMeeting, topicOf, type Meeting } from "./data.ts";
import { Captions } from "../Captions.tsx";
import type { Camera, Command, Hint, View, ViewMode } from "./ProtoCanvas.tsx";
import "./proto.css";
import { VARIANTS, type VariantKey } from "./variants.tsx";

const params = new URLSearchParams(location.search);
const setParam = (k: string, v: string) => {
  params.set(k, v);
  history.replaceState(null, "", `?${params}`);
};
const CAMERAS: Camera[] = ["focus", "glance", "fit"];
const CAMERA_NAME: Record<Camera, string> = { focus: "今の議題に寄る", glance: "議題が変わったら全体→寄る", fit: "常に全体（今の作り）" };
const HINTS: Hint[] = ["text", "count", "none"];
const HINT_NAME: Record<Hint, string> = { text: "中身の手がかり（文字）", count: "隠れた数（Drawnix 風）", none: "議題名だけ" };
type Ret = "idle" | "topic" | "key";
const RETS: Ret[] = ["idle", "topic", "key"];
const RET_NAME: Record<Ret, string> = { idle: "触らなければ N 秒で戻る", topic: "今の議題が変わったら戻る", key: "Esc を押すまで戻らない" };
const HELP: [string, string][] = [
  ["Esc", "今の議題へ戻る・選択を外す"],
  ["F", "全体を見る（もう一度で戻る）"],
  ["= / -", "拡大・縮小"],
  ["0", "倍率を 1.0 に"],
  ["Z", "選んだノードへ寄る"],
  ["Shift＋矢印", "移動"],
  ["E", "右の列を出す・隠す"],
  ["C", "字幕を出す・隠す"],
  ["?", "キー一覧"],
  ["スクロール・ドラッグ", "移動"],
  ["⌘＋Shift＋スクロール", "縦か横だけに移動"],
  ["⌘＋スクロール・ピンチ", "拡大・縮小"],
  ["⌘＋クリック", "押したところを拡大（Option で縮小）"],
];
type Cue = "none" | "text" | "count";
const CUE_NAME: Record<Cue, string> = { none: "止まっていることを出さない", text: "隅に控えめな文字", count: "隅に文字＋残り秒" };

function App() {
  const [sample, setSample] = useState(params.get("sample") ?? "parnassus");
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [index, setIndex] = useState(0);
  const [variant] = useState<VariantKey>((params.get("variant") as VariantKey) ?? "A");
  const [camera, setCamera] = useState<Camera>((params.get("camera") as Camera) ?? "focus");
  const [nested, setNested] = useState(params.get("nest") === "1");
  const [runs, setRuns] = useState(params.get("runs") !== "0");
  const [stale, setStale] = useState(Number(params.get("stale") ?? "15"));
  const [hint, setHint] = useState<Hint>((params.get("hint") as Hint) ?? "text");
  const [playing, setPlaying] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null); // 選択・目次で見ている議題（次の反映で今の議題に戻る）
  // PROTOTYPE（issue #285）
  const [ret, setRet] = useState<Ret>((params.get("ret") as Ret) ?? "idle");
  const [idleSec, setIdleSec] = useState(Number(params.get("idle") ?? "10"));
  const [minZoom, setMinZoom] = useState(Number(params.get("zmin") ?? "0.5"));
  const [cue, setCue] = useState<Cue>((params.get("cue") as Cue) ?? "text");
  const [offscreen, setOffscreen] = useState(params.get("off") !== "0");
  const [overviewOpen, setOverviewOpen] = useState(params.get("ovopen") === "1"); // 全体を見るとき、畳んだ議題も開く
  const [mode, setMode] = useState<ViewMode>("follow");
  const [openAll, setOpenAll] = useState(false); // 全体を見て開いたまま（自動のカメラへ戻るまで）
  const lastMove = useRef(0);
  const [command, setCommand] = useState<Command | null>(null);
  const [showSide, setShowSide] = useState(true);
  const [showCaptions, setShowCaptions] = useState(true);
  const [showHelp, setShowHelp] = useState(false);
  const selectedRef = useRef<string | null>(null);
  const [now, setNow] = useState(0);
  const onUserMove = useCallback(() => {
    lastMove.current = performance.now();
    setMode((m) => (m === "manual" ? m : "manual"));
  }, []);
  const follow = useCallback(() => {
    setMode("follow");
    setOpenAll(false);
  }, []);

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

  // 戻る条件: 触らなければ N 秒
  useEffect(() => {
    if (mode !== "manual" || ret !== "idle") return; // 全体を見ている間は時間では戻らない
    const t = setInterval(() => {
      const n = performance.now();
      setNow(n);
      if (n - lastMove.current >= idleSec * 1000) follow();
    }, 200);
    return () => clearInterval(t);
  }, [mode, ret, idleSec, follow]);
  // 戻る条件: 今の議題が変わったら
  const lastCurrent = useRef<string | null>(null);
  useEffect(() => {
    const cur = frame?.current ?? null;
    if (ret === "topic" && mode !== "follow" && lastCurrent.current !== cur) follow();
    lastCurrent.current = cur;
  }, [frame, ret, mode, follow]);

  // 反映で何か変わったら、選択で見ていた議題から今の議題に戻る
  useEffect(() => {
    if (frame && frame.snapshot.changes.some((c) => c.round === frame.snapshot.round)) setPinned(null);
  }, [frame]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return; // ブラウザ・会議アプリのキーには触れない
      const move = (c: Omit<Command, "seq">) => {
        lastMove.current = performance.now();
        setMode("manual");
        setCommand((prev) => ({ ...c, seq: (prev?.seq ?? 0) + 1 }));
      };
      const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (e.key in arrows) {
        if (!e.shiftKey) return; // 矢印だけはノードの選択に空けておく
        e.preventDefault();
        const [x, y] = arrows[e.key]!;
        move({ type: "pan", dx: x / 3, dy: y / 3 });
        return;
      }
      switch (e.key) {
        case "Escape":
          if (showHelpRef.current) return setShowHelp(false);
          setSelectedId(null);
          follow();
          return;
        case "f":
        case "F":
          // もう一度押すと今の議題へ戻る
          setMode((m) => {
            if (m === "overview") {
              setOpenAll(false);
              return "follow";
            }
            setOpenAll(true);
            return "overview";
          });
          return;
        case "=":
        case "+":
          return move({ type: "in" });
        case "-":
          return move({ type: "out" });
        case "0":
          return move({ type: "one" });
        case "z":
        case "Z":
          if (selectedRef.current) move({ type: "node" });
          return;
        case "e":
        case "E":
          return setShowSide((v) => !v);
        case "c":
        case "C":
          return setShowCaptions((v) => !v);
        case "?":
          return setShowHelp((v) => !v);
        case "[":
        case "]": {
          const d = e.key === "]" ? 1 : -1;
          return setIndex((i) => Math.max(0, Math.min((meeting?.diffEnds.length ?? 1) - 1, i + d)));
        }
        case " ":
          e.preventDefault();
          return setPlaying((p) => !p);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [meeting, follow]);

  const showHelpRef = useRef(showHelp);
  showHelpRef.current = showHelp;
  selectedRef.current = selectedId;

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
  for (const start of [pinned, frame.current]) for (let cur: string | null | undefined = start; cur && cur !== "root"; cur = byId.get(cur)?.parent) opened.add(cur);
  const folded = openAll && overviewOpen ? new Set<string>() : foldedIds(frame, opened, stale);
  const view: View = { mode, minZoom, offscreen, onUserMove, command };
  // 字幕: 試作では、今の反映の時点までの直近の発言 2 つを「相手」の字幕として出す
  const recent = meeting.events
    .slice(0, meeting.diffEnds[index])
    .filter((e: any) => e.type === "remark")
    .slice(-2)
    .map((e: any) => e.remark.text as string)
    .join("");
  const left = Math.max(0, Math.ceil(idleSec - (now - lastMove.current) / 1000));
  const cueText =
    mode === "follow" || cue === "none"
      ? null
      : mode === "overview"
        ? "全体を見ています・F か Esc で今の議題へ"
        : ret === "idle" && cue === "count"
        ? `${left} 秒で今の議題へ戻ります（Esc ですぐ）`
        : ret === "idle"
          ? "動かしています・触らなければ今の議題へ戻ります"
          : ret === "topic"
            ? "動かしています・議題が変わるか Esc で今の議題へ"
            : "今の議題を追っていません・Esc で戻る";
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
            view={view}
          />
          {cueText && <p className="proto-cue">{cueText}</p>}
          {showCaptions && <Captions speaking={{ 相手: recent, 自分: "" }} />}
          {showHelp && (
            <dl className="proto-help">
              {HELP.map(([k, d]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{d}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
        <div className="side" hidden={!showSide}>
          <EvidencePanel selectedId={selectedId} evidence={selectedId === null ? null : evidenceOf(frame.snapshot, selectedId)} />
          <ChangeList changes={frame.snapshot.changes.slice(-200)} onSelect={onSelect} />
        </div>
      </div>
      <div className="proto-bar">
        <select value={sample} onChange={(e) => (setSample(e.target.value), setParam("sample", e.target.value))}>
          <option value="parnassus">parnassus 161 分</option>
          <option value="silly">silly 76 分</option>
        </select>
        <button type="button" onClick={() => setRet((v) => { const n = RETS[(RETS.indexOf(v) + RETS.length - 1) % RETS.length]!; setParam("ret", n); return n; })}>←</button>
        <strong>
          {RETS.indexOf(ret) + 1}/{RETS.length} {RET_NAME[ret].replace("N", String(idleSec))}
        </strong>
        <button type="button" onClick={() => setRet((v) => { const n = RETS[(RETS.indexOf(v) + 1) % RETS.length]!; setParam("ret", n); return n; })}>→</button>
        <select value={idleSec} onChange={(e) => (setIdleSec(Number(e.target.value)), setParam("idle", e.target.value))}>
          {[5, 10, 20, 30].map((n) => (
            <option key={n} value={n}>{n} 秒</option>
          ))}
        </select>
        <select value={cue} onChange={(e) => (setCue(e.target.value as Cue), setParam("cue", e.target.value))}>
          {(Object.keys(CUE_NAME) as Cue[]).map((c) => (
            <option key={c} value={c}>{CUE_NAME[c]}</option>
          ))}
        </select>
        <select value={minZoom} onChange={(e) => (setMinZoom(Number(e.target.value)), setParam("zmin", e.target.value))}>
          {[0.75, 0.5, 0.35, 0.2, 0.05].map((z) => (
            <option key={z} value={z}>縮小の下限 {z}（文字 {Math.round(14 * z * 10) / 10}px）</option>
          ))}
        </select>
        <label>
          <input type="checkbox" checked={offscreen} onChange={(e) => (setOffscreen(e.target.checked), setParam("off", e.target.checked ? "1" : "0"))} />
          画面の外の変化を縁に
        </label>
        <label>
          <input type="checkbox" checked={overviewOpen} onChange={(e) => (setOverviewOpen(e.target.checked), setParam("ovopen", e.target.checked ? "1" : "0"))} />
          全体（F）で畳んだ議題も開く
        </label>
        <span className="proto-bar__info">[{mode === "follow" ? "自動" : mode === "overview" ? "全体" : "手動"}]</span>
        <span className="proto-bar__sep" />
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
        <select value={stale} onChange={(e) => (setStale(Number(e.target.value)), setParam("stale", e.target.value))}>
          {[0, 10, 15, 20, 30].map((m) => (
            <option key={m} value={m}>
              {m === 0 ? "古い話し中も開く" : `${m} 分触れなければ畳む`}
            </option>
          ))}
        </select>
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
