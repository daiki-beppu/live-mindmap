// PROTOTYPE（issue #300）: 見返し用のマップで時刻を動かす操作の 3 案。main には入れない。
//   web/public/proto-long/<名前>/ に log.jsonl・closes.jsonl を置く（prototype-long-meeting/prepare.sh）
//   pnpm -C web dev → http://localhost:5173/prototype-review.html?variant=A&sample=parnassus
// 画面はライブと同じ（今の議題に寄る・畳む・右の列・字幕・人が動かした後の戻り方）にし、時刻を動かす操作だけを ?variant= で切り替える。
//   A 動画のように: 会議の時刻の軸・▶ は会議の時刻に比例（倍速）・コマ送りは反映 1 回・目印は議題の始まりと決定・TODO
//   B 反映の目盛り: 反映の回数の軸（1 回ずつの目盛りに差分操作を積む）・コマ送りは差分操作 1 件・▶ は一定の間隔
//   C 議題の章立て: 議題ごとの帯を章として並べる（会議の時刻の軸）・押すとその議題の始まりへ・▶ は反映を一定の間隔
// 開いた直後は最後の時点で止めておく。
import { Slider } from "@videojs/react";
import { StrictMode, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { ChangeEntry, SnapshotNode } from "../../../server/src/core/index.ts";
import { Captions } from "../Captions.tsx";
import { ChangeList } from "../ChangeList.tsx";
import { EvidencePanel } from "../EvidencePanel.tsx";
import { evidenceOf } from "../evidence.ts";
import { KIND_COLOR } from "../kinds.ts";
import "../styles.css";
import { clock, foldedIds, frameAt, loadMeeting, topicOf, type Frame, type Meeting } from "../prototype-long-meeting/data.ts";
import type { Command, View, ViewMode } from "../prototype-long-meeting/ProtoCanvas.tsx";
import "../prototype-long-meeting/proto.css";
import { VariantA as Canvas } from "../prototype-long-meeting/variants.tsx";
import "./review.css";

const params = new URLSearchParams(location.search);
const setParam = (k: string, v: string) => {
  params.set(k, v);
  history.replaceState(null, "", `?${params}`);
};

type VariantKey = "A" | "B" | "C";
const VARIANTS: Record<VariantKey, string> = { A: "動画のように（時刻の軸・倍速）", B: "反映の目盛り（差分操作 1 件ずつ）", C: "議題の章立て" };
const KEYS = Object.keys(VARIANTS) as VariantKey[];
// 見返し中に人が画面を動かしたあと、自動のカメラへ戻る条件
type Ret = "idle" | "time" | "both";
const RET_NAME: Record<Ret, string> = { idle: "触らなければ 10 秒で戻る（ライブと同じ）", time: "時刻を動かしたら戻る", both: "どちらか早い方" };
const IDLE_SEC = 10;
const STALE_MIN = 15;

// 時刻の位置。index は反映（diff）の番号、ops はその反映の先頭の何件の差分操作までか（undefined は全部）、t は会議の中の秒
type Pos = { index: number; ops?: number; t: number };

// 全体の目印（最後の時点のマップから作る）
type Marks = {
  end: number;
  topicStarts: { at: number; text: string }[];
  keys: { at: number; kind: SnapshotNode["kind"]; text: string }[];
  chapters: { topic: string; text: string; from: number; to: number }[];
  steps: { index: number; ops?: number; kinds: string[] }[]; // B: 差分操作 1 件ずつの位置
};

function marksOf(m: Meeting, final: Frame): Marks {
  const remarkEnd = Math.max(0, ...m.events.filter((e: any) => e.type === "remark").map((e: any) => e.remark.end as number));
  const end = Math.max(remarkEnd, m.diffAt.at(-1) ?? 0);
  const byId = new Map(final.snapshot.nodes.map((n) => [n.id, n]));
  const ch = final.snapshot.changes;
  const topicStarts = ch.filter((c) => c.kind === "議題" && c.change === "追加").map((c) => ({ at: c.at, text: c.text }));
  const keys = ch
    .filter((c) => (c.change === "追加" && (c.kind === "決定" || c.kind === "TODO")) || c.change === "決定済み化")
    .map((c) => ({ at: c.at, kind: (c.change === "決定済み化" ? "決定" : c.kind) as SnapshotNode["kind"], text: c.text }));
  const chapters: Marks["chapters"] = [];
  for (const c of ch) {
    const t = topicOf(byId, c.node);
    if (!t) continue;
    const last = chapters.at(-1);
    if (last?.topic === t) continue;
    if (last) last.to = c.at;
    chapters.push({ topic: t, text: byId.get(t)?.text ?? "", from: c.at, to: end });
  }
  if (chapters[0]) chapters[0].from = 0;
  // 行き来で細切れになるので、45 秒未満の切れ端は前の章に含め、同じ議題が隣り合えばつなぐ
  const merged: Marks["chapters"] = [];
  for (const c of chapters) {
    const prev = merged.at(-1);
    if (prev && (c.to - c.from < 45 || prev.topic === c.topic)) prev.to = c.to;
    else merged.push({ ...c });
  }
  const steps: Marks["steps"] = [];
  m.diffEnds.forEach((e, index) => {
    const ops = (m.events[e - 1] as { ops: { op: string; kind?: string }[] }).ops;
    if (ops.length === 0) return steps.push({ index, kinds: [] });
    ops.forEach((o, k) => steps.push({ index, ops: k + 1 === ops.length ? undefined : k + 1, kinds: [o.op === "add" ? (o.kind ?? "") : o.op] }));
  });
  return { end, topicStarts, keys, chapters: merged, steps };
}

const HELP: [string, string][] = [
  ["Space", "▶ 見返しを進める・止める"],
  ["[ ]", "1 つ戻る・進む（A・C は反映 1 回、B は差分操作 1 件）"],
  ["Shift＋[ ]", "大きく戻る・進む（A は 1 分、B は反映 1 回、C は議題 1 つ）"],
  ["Home / End", "最初・最後へ"],
  ["Esc", "今の議題へ戻る・選択を外す"],
  ["F", "全体を見る（もう一度で戻る）"],
  ["= / -", "拡大・縮小"],
  ["0", "倍率を 1.0 に"],
  ["Z", "選んだノードへ寄る"],
  ["Shift＋矢印", "移動"],
  ["E", "右の列を出す・隠す"],
  ["C", "字幕を出す・隠す"],
  ["?", "キー一覧"],
];
// 日本語入力がオンでも効くように、全角の記号・入力中（Process）のキーを半角のキーに直す
const WIDE: Record<string, string> = { "？": "?", "＝": "=", "＋": "+", "－": "-", "ー": "-", "０": "0", "［": "[", "］": "]", "「": "[", "」": "]", "『": "[", "』": "]", "{": "[", "}": "]", "｛": "[", "｝": "]", "　": " " };
function keyOf(e: KeyboardEvent): string {
  if (e.key === "Process" || e.key === "Unidentified" || e.isComposing) {
    if (e.code.startsWith("Key")) return e.code.slice(3).toLowerCase();
    if (e.code.startsWith("Digit")) return e.code.slice(5);
    const byCode: Record<string, string> = { Slash: e.shiftKey ? "?" : "/", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Space: " " };
    return byCode[e.code] ?? e.key;
  }
  if (WIDE[e.key]) return WIDE[e.key]!;
  if (/^[ａ-ｚＡ-Ｚ]$/.test(e.key)) return String.fromCharCode(e.key.charCodeAt(0) - 0xfee0);
  return e.key;
}

function App() {
  const [sample, setSample] = useState(params.get("sample") ?? "parnassus");
  const [variant, setVariant] = useState<VariantKey>(KEYS.includes(params.get("variant") as VariantKey) ? (params.get("variant") as VariantKey) : "A");
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const [marks, setMarks] = useState<Marks | null>(null);
  const [pos, setPos] = useState<Pos>({ index: 0, t: 0 });
  const [playing, setPlaying] = useState(false);
  const [speedA, setSpeedA] = useState(Number(params.get("x") ?? "30")); // A: 会議の時刻の何倍で進めるか
  const [stepMs, setStepMs] = useState(Number(params.get("ms") ?? "800")); // B・C: 1 つ進める間隔
  const [ret, setRet] = useState<Ret>((params.get("ret") as Ret) ?? "both");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pinned, setPinned] = useState<string | null>(null);
  const [mode, setMode] = useState<ViewMode>("follow");
  const [command, setCommand] = useState<Command | null>(null);
  const [showSide, setShowSide] = useState(true);
  const [showCaptions, setShowCaptions] = useState(true);
  const [showHelp, setShowHelp] = useState(false);
  const lastMove = useRef(0);
  const onUserMove = useCallback(() => {
    lastMove.current = performance.now();
    setMode((m) => (m === "manual" ? m : "manual"));
  }, []);
  const follow = useCallback(() => setMode("follow"), []);

  useEffect(() => {
    setMeeting(null);
    void loadMeeting(sample).then((m) => {
      const last = m.diffEnds.length - 1;
      const mk = marksOf(m, frameAt(m, last));
      setMeeting(m);
      setMarks(mk);
      // 開いた直後は最後の時点で止めておく（?min= で途中から）
      const min = params.get("min");
      if (min === null) setPos({ index: last, t: mk.end });
      else {
        const t = Number(min) * 60;
        setPos({ index: Math.max(0, m.diffAt.findLastIndex((a) => a <= t)), t });
      }
    });
  }, [sample]);

  // 位置を作る（範囲に収める）
  const last = (meeting?.diffEnds.length ?? 1) - 1;
  const atTime = useCallback(
    (t: number): Pos => {
      if (!meeting || !marks) return { index: 0, t: 0 };
      const c = Math.max(0, Math.min(marks.end, t));
      return { index: Math.max(0, meeting.diffAt.findLastIndex((a) => a <= c)), t: c };
    },
    [meeting, marks],
  );
  const atIndex = useCallback((i: number, ops?: number): Pos => {
    if (!meeting) return { index: 0, t: 0 };
    const index = Math.max(0, Math.min(meeting.diffEnds.length - 1, i));
    return { index, ops, t: meeting.diffAt[index]! };
  }, [meeting]);

  // 人が時刻を動かした（コマ送り・シーク・最初・最後）。戻る条件が「時刻」なら自動のカメラへ戻す
  const retRef = useRef(ret);
  retRef.current = ret;
  const seek = useCallback(
    (p: Pos) => {
      setPos(p);
      if (retRef.current !== "idle") follow();
    },
    [follow],
  );

  // 戻る条件: 触らなければ 10 秒
  useEffect(() => {
    if (mode !== "manual" || ret === "time") return;
    const t = setInterval(() => {
      if (performance.now() - lastMove.current >= IDLE_SEC * 1000) follow();
    }, 200);
    return () => clearInterval(t);
  }, [mode, ret, follow]);

  // ▶: A は会議の時刻に比例して t を進める。B は差分操作、C は反映を一定の間隔で進める
  useEffect(() => {
    if (!playing || !meeting || !marks) return;
    if (variant === "A") {
      let prev = performance.now();
      const id = setInterval(() => {
        const n = performance.now();
        const dt = ((n - prev) / 1000) * speedA;
        prev = n;
        setPos((p) => {
          const next = atTime(p.t + dt);
          if (next.t >= marks.end) setPlaying(false);
          return next;
        });
      }, 100);
      return () => clearInterval(id);
    }
    const id = setInterval(() => {
      setPos((p) => {
        if (variant === "B") {
          const k = stepIndexOf(marks, p);
          const s = marks.steps[Math.min(marks.steps.length - 1, k + 1)]!;
          if (k + 1 >= marks.steps.length - 1) setPlaying(false);
          return atIndex(s.index, s.ops);
        }
        if (p.index + 1 >= meeting.diffEnds.length - 1) setPlaying(false);
        return atIndex(p.index + 1);
      });
    }, stepMs);
    return () => clearInterval(id);
  }, [playing, variant, meeting, marks, speedA, stepMs, atTime, atIndex]);

  const togglePlay = useCallback(() => {
    setPlaying((p) => {
      // 最後で ▶ を押したら最初から
      if (!p && meeting && marks && pos.index >= last && pos.ops === undefined) setPos(variant === "A" ? atTime(0) : atIndex(0, variant === "B" ? marks.steps[0]?.ops : undefined));
      return !p;
    });
    if (retRef.current !== "idle") follow();
  }, [meeting, marks, pos, last, variant, atTime, atIndex, follow]);

  // 1 つ・大きく戻る進む
  const step = useCallback(
    (dir: 1 | -1, big: boolean) => {
      if (!meeting || !marks) return;
      setPlaying(false);
      if (variant === "A") {
        if (big) return seek(atTime(pos.t + dir * 60));
        // 反映 1 回。途中の時刻にいるときは、戻るはその反映の時点へ
        if (dir === -1 && pos.t > meeting.diffAt[pos.index]! + 0.01) return seek(atIndex(pos.index));
        return seek(atIndex(pos.index + dir));
      }
      if (variant === "B") {
        if (big) return seek(atIndex(pos.index + dir));
        const k = stepIndexOf(marks, pos);
        const s = marks.steps[Math.max(0, Math.min(marks.steps.length - 1, k + dir))]!;
        return seek(atIndex(s.index, s.ops));
      }
      if (big) {
        const c = chapterIndexOf(marks, pos.t);
        const target = dir === 1 ? marks.chapters[c + 1] : pos.t - marks.chapters[c]!.from > 5 ? marks.chapters[c] : marks.chapters[c - 1];
        if (target) seek(chapterStart(meeting, target.from, atIndex));
        return;
      }
      seek(atIndex(pos.index + dir));
    },
    [meeting, marks, variant, pos, seek, atTime, atIndex],
  );

  const frame = useMemo(() => (meeting ? frameAt(meeting, pos.index, false, pos.ops) : null), [meeting, pos.index, pos.ops]);

  // 反映で何か変わったら、選択で見ていた議題から今の議題に戻る
  useEffect(() => {
    if (frame && frame.snapshot.changes.some((c) => c.round === frame.snapshot.round)) setPinned(null);
  }, [frame]);

  const showHelpRef = useRef(showHelp);
  showHelpRef.current = showHelp;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const actions = useRef({ step, togglePlay, seekEnd: (end: boolean) => {} });
  actions.current = {
    step,
    togglePlay,
    seekEnd: (end) => {
      if (!meeting || !marks) return;
      setPlaying(false);
      if (end) seek(variant === "A" ? atTime(marks.end) : atIndex(last));
      else seek(variant === "A" ? atTime(0) : atIndex(0, variant === "B" ? marks.steps[0]?.ops : undefined));
    },
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const key = keyOf(e);
      const move = (c: Omit<Command, "seq">) => {
        lastMove.current = performance.now();
        setMode("manual");
        setCommand((prev) => ({ ...c, seq: (prev?.seq ?? 0) + 1 }));
      };
      const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (key in arrows) {
        if (!e.shiftKey) return; // 矢印だけはノードの選択に空けておく
        e.preventDefault();
        const [x, y] = arrows[key]!;
        move({ type: "pan", dx: x / 3, dy: y / 3 });
        return;
      }
      switch (key) {
        case "Escape":
          if (showHelpRef.current) return setShowHelp(false);
          setSelectedId(null);
          return follow();
        case "f":
        case "F":
          return setMode((m) => (m === "overview" ? "follow" : "overview"));
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
        case "]":
          e.preventDefault();
          return actions.current.step(key === "]" ? 1 : -1, e.shiftKey);
        case " ":
          e.preventDefault();
          return actions.current.togglePlay();
        case "Home":
        case "End":
          e.preventDefault();
          return actions.current.seekEnd(key === "End");
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [follow]);

  const byId = useMemo(() => new Map(frame?.snapshot.nodes.map((n) => [n.id, n]) ?? []), [frame]);
  const onSelect = useCallback(
    (id: string) => {
      setSelectedId(id);
      const t = topicOf(byId, id);
      if (t) setPinned(t);
    },
    [byId],
  );

  if (!meeting || !marks || !frame) return <p className="waiting">素材を読み込んでいます</p>;
  const focusTopic = pinned ?? frame.current;
  const opened = new Set<string>();
  for (const start of [pinned, frame.current]) for (let cur: string | null | undefined = start; cur && cur !== "root"; cur = byId.get(cur)?.parent) opened.add(cur);
  const folded = foldedIds(frame, opened, STALE_MIN);
  const view: View = { mode, minZoom: 0.5, offscreen: true, onUserMove, command, inset: 0, side: showSide };
  // 字幕: 見ている時刻に話していた発言（終わってから 8 秒までは残す）を、話し手ごとに 1 つ
  const speaking = { 相手: "", 自分: "" };
  for (const e of meeting.events as any[]) {
    if (e.type !== "remark") continue;
    const r = e.remark as { track: "相手" | "自分"; start: number; end: number; text: string };
    if (r.start > pos.t) break;
    if (pos.t <= r.end + 8) speaking[r.track] = r.text;
  }
  const cueText = mode === "follow" ? null : mode === "overview" ? "全体を見ています・F か Esc で今の議題へ" : ret === "time" ? "動かしています・時刻を動かすか Esc で今の議題へ" : "動かしています・触らなければ今の議題へ戻ります";
  const player = { meeting, marks, pos, frame, playing, togglePlay, step, seek, atTime, atIndex };

  return (
    <>
      <div className="layout">
        <div className="review-col">
          <div className="map">
            <Canvas frame={frame} folded={folded} focusTopic={focusTopic} hint="text" camera="focus" selectedId={selectedId} onSelect={onSelect} onPickTopic={setPinned} runs view={view} />
            {cueText && <p className="proto-cue">{cueText}</p>}
            {showCaptions && <Captions speaking={speaking} />}
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
          {variant === "A" && <PlayerA {...player} speed={speedA} setSpeed={(x) => (setSpeedA(x), setParam("x", String(x)))} />}
          {variant === "B" && <PlayerB {...player} ms={stepMs} setMs={(x) => (setStepMs(x), setParam("ms", String(x)))} />}
          {variant === "C" && <PlayerC {...player} ms={stepMs} setMs={(x) => (setStepMs(x), setParam("ms", String(x)))} />}
        </div>
        <div className="side" hidden={!showSide}>
          <EvidencePanel selectedId={selectedId} evidence={selectedId === null ? null : evidenceOf(frame.snapshot, selectedId)} />
          <ChangeList changes={frame.snapshot.changes.slice(-200)} onSelect={onSelect} />
        </div>
      </div>
      {/* 試作の切り替え（評価する画面の一部ではない） */}
      <div className="proto-bar review-switch" onChange={(e) => (e.target as HTMLElement).blur()} onMouseUp={(e) => e.target instanceof HTMLButtonElement && e.target.blur()}>
        <select value={sample} onChange={(e) => (setSample(e.target.value), setParam("sample", e.target.value))}>
          <option value="parnassus">parnassus 161 分</option>
          <option value="silly">silly 76 分</option>
        </select>
        <button type="button" onClick={() => { const n = KEYS[(KEYS.indexOf(variant) + KEYS.length - 1) % KEYS.length]!; setPlaying(false); setVariant(n); setParam("variant", n); }}>←</button>
        <strong>
          {variant} {VARIANTS[variant]}
        </strong>
        <button type="button" onClick={() => { const n = KEYS[(KEYS.indexOf(variant) + 1) % KEYS.length]!; setPlaying(false); setVariant(n); setParam("variant", n); }}>→</button>
        <span className="proto-bar__sep" />
        <select value={ret} onChange={(e) => (setRet(e.target.value as Ret), setParam("ret", e.target.value))}>
          {(Object.keys(RET_NAME) as Ret[]).map((r) => (
            <option key={r} value={r}>{RET_NAME[r]}</option>
          ))}
        </select>
        <span className="proto-bar__info">[{mode === "follow" ? "自動" : mode === "overview" ? "全体" : "手動"}]・? キー一覧</span>
      </div>
    </>
  );
}

const stepIndexOf = (marks: Marks, p: Pos) => Math.max(0, marks.steps.findIndex((s) => s.index === p.index && s.ops === p.ops));
const chapterIndexOf = (marks: Marks, t: number) => Math.max(0, marks.chapters.findLastIndex((c) => c.from <= t));
// 章の始まり: その議題に最初に触れた反映の時点
function chapterStart(m: Meeting, from: number, atIndex: (i: number) => Pos): Pos {
  const i = m.diffAt.findIndex((a) => a >= from);
  return atIndex(i < 0 ? m.diffAt.length - 1 : i);
}

type PlayerProps = {
  meeting: Meeting;
  marks: Marks;
  pos: Pos;
  frame: Frame;
  playing: boolean;
  togglePlay: () => void;
  step: (dir: 1 | -1, big: boolean) => void;
  seek: (p: Pos) => void;
  atTime: (t: number) => Pos;
  atIndex: (i: number, ops?: number) => Pos;
};

// シークバー: Video.js 10 の汎用 Slider（プレイヤーにつながない。値は外から渡す）。
// 目印・帯は Track の中に自前で置く（left は %）。ホバーの位置の値を Preview に出す。
// 矢印・Home/End はつまみにフォーカスがあるときだけ効く。押して離したらフォーカスを外し、矢印をノードの選択に返す
function ReviewSlider(p: { max: number; value: number; step: number; largeStep: number; onChange: (v: number) => void; valueText: (v: number) => string; preview: (v: number) => string; children?: ReactNode }) {
  return (
    <Slider.Root
      className="review-slider"
      label="見返しの時刻"
      min={0}
      max={p.max}
      step={p.step}
      largeStep={p.largeStep}
      value={p.value}
      onValueChange={p.onChange}
      onPointerUp={() => (document.activeElement as HTMLElement | null)?.blur()}
    >
      <Slider.Track className="review-slider__track">
        {p.children}
        <Slider.Fill className="review-slider__fill" />
      </Slider.Track>
      <Slider.Thumb className="review-slider__thumb" aria-valuetext={p.valueText(p.value)} />
      <Slider.Preview className="review-slider__preview">
        <Slider.Value type="pointer" format={p.preview} />
      </Slider.Preview>
    </Slider.Root>
  );
}

const Speed = ({ value, options, unit, onChange }: { value: number; options: number[]; unit: (n: number) => string; onChange: (n: number) => void }) => (
  <select className="review-player__speed" value={value} onChange={(e) => (onChange(Number(e.target.value)), e.target.blur())}>
    {options.map((o) => (
      <option key={o} value={o}>{unit(o)}</option>
    ))}
  </select>
);

// A: 動画のように。会議の時刻の軸に、議題の始まり（細い線）と決定・TODO（小さな点）
function PlayerA(p: PlayerProps & { speed: number; setSpeed: (n: number) => void }) {
  const { marks, pos } = p;
  const x = (t: number) => `${(t / marks.end) * 100}%`;
  return (
    <div className="review-player review-player--a">
      <button type="button" className="review-player__play" onClick={p.togglePlay} aria-label={p.playing ? "止める" : "進める"}>{p.playing ? "❚❚" : "▶"}</button>
      <span className="review-player__time">{clock(pos.t)} / {clock(marks.end)}</span>
      <ReviewSlider
        max={marks.end}
        value={pos.t}
        step={5}
        largeStep={60}
        onChange={(v) => p.seek(p.atTime(v))}
        valueText={(v) => `${clock(v)} / ${clock(marks.end)}`}
        preview={(v) => `${clock(v)} ${marks.chapters[chapterIndexOf(marks, v)]?.text ?? ""}`}
      >
        {marks.topicStarts.map((m, i) => <span key={i} className="review-a__topic" style={{ left: x(m.at) }} />)}
        {marks.keys.map((m, i) => <span key={i} className="review-a__key" style={{ left: x(m.at), background: KIND_COLOR[m.kind] }} />)}
      </ReviewSlider>
      <Speed value={p.speed} options={[10, 30, 60, 120]} unit={(n) => `${n} 倍`} onChange={p.setSpeed} />
    </div>
  );
}

// B: 反映の目盛り。反映 1 回を 1 列、差分操作を下から積む。今の位置の操作を言葉でも出す
function PlayerB(p: PlayerProps & { ms: number; setMs: (n: number) => void }) {
  const { meeting, marks, pos, frame } = p;
  const n = meeting.diffEnds.length;
  const k = stepIndexOf(marks, pos);
  const columns = useMemo(() => {
    const cols: { index: number; cells: { k: number; kind: string }[] }[] = [];
    marks.steps.forEach((s, i) => {
      if (cols.at(-1)?.index !== s.index) cols.push({ index: s.index, cells: [] });
      cols.at(-1)!.cells.push({ k: i, kind: s.kinds[0] ?? "" });
    });
    return cols;
  }, [marks]);
  const lastChange: ChangeEntry | undefined = frame.snapshot.changes.at(-1);
  const opsHere = marks.steps.filter((s) => s.index === pos.index).length;
  const opNo = pos.ops ?? opsHere;
  return (
    <div className="review-player review-player--b">
      <button type="button" className="review-player__play" onClick={p.togglePlay} aria-label={p.playing ? "止める" : "進める"}>{p.playing ? "❚❚" : "▶"}</button>
      <div className="review-b__where">
        <span className="review-player__time">{clock(pos.t)}・反映 {pos.index + 1}/{n}・{opNo}/{opsHere} 件目</span>
        <span className="review-b__op">{lastChange ? `${lastChange.change} ${lastChange.kind}「${lastChange.text}」` : "-"}</span>
      </div>
      <ReviewSlider
        max={marks.steps.length - 1}
        value={k}
        step={1}
        largeStep={10}
        onChange={(v) => {
          const s = marks.steps[Math.round(v)]!;
          p.seek(p.atIndex(s.index, s.ops));
        }}
        valueText={() => `反映 ${pos.index + 1} / ${n}、${opNo} / ${opsHere} 件目`}
        preview={(v) => {
          const s = marks.steps[Math.round(v)]!;
          return `${clock(meeting.diffAt[s.index]!)}・反映 ${s.index + 1}`;
        }}
      >
        <div className="review-b__cols">
          {columns.map((c) => (
            <span key={c.index} className="review-b__col" style={{ flexGrow: c.cells.length || 1 }}>
              {c.cells.map((cell) => (
                <span
                  key={cell.k}
                  className={`review-b__cell${cell.k <= k ? " review-b__cell--done" : ""}${cell.k === k ? " review-b__cell--now" : ""}`}
                  style={{ background: cell.kind in KIND_COLOR ? KIND_COLOR[cell.kind as SnapshotNode["kind"]] : undefined }}
                />
              ))}
            </span>
          ))}
        </div>
      </ReviewSlider>
      <Speed value={p.ms} options={[300, 600, 800, 1200]} unit={(n) => `1 件 ${n / 1000} 秒`} onChange={p.setMs} />
    </div>
  );
}

// C: 議題の章立て。議題ごとの帯（会議の時刻の幅）を並べ、押すとその議題の始まりへ。前後の章への送り
function PlayerC(p: PlayerProps & { ms: number; setMs: (n: number) => void }) {
  const { meeting, marks, pos } = p;
  const c = chapterIndexOf(marks, pos.t);
  const now = marks.chapters[c];
  const x = (t: number) => `${(t / marks.end) * 100}%`;
  return (
    <div className="review-player review-player--c">
      <button type="button" className="review-player__btn" onClick={() => p.step(-1, true)} aria-label="前の議題">⏮</button>
      <button type="button" className="review-player__play" onClick={p.togglePlay} aria-label={p.playing ? "止める" : "進める"}>{p.playing ? "❚❚" : "▶"}</button>
      <button type="button" className="review-player__btn" onClick={() => p.step(1, true)} aria-label="次の議題">⏭</button>
      <div className="review-c__body">
        <div className="review-c__head">
          <span className="review-player__time">{clock(pos.t)}</span>
          <span className="review-c__title">{now?.text ?? "-"}</span>
        </div>
        <ReviewSlider
          max={marks.end}
          value={pos.t}
          step={5}
          largeStep={60}
          onChange={(v) => p.seek(p.atTime(v))}
          valueText={(v) => `${clock(v)}、${now?.text ?? ""}`}
          preview={(v) => `${clock(v)} ${marks.chapters[chapterIndexOf(marks, v)]?.text ?? ""}`}
        >
          {marks.chapters.map((ch, i) => (
            <span
              key={i}
              className={`review-c__chapter${i === c ? " review-c__chapter--now" : ""}${ch.to <= pos.t ? " review-c__chapter--done" : ""}`}
              style={{ left: x(ch.from), width: x(ch.to - ch.from) }}
            >
              {(ch.to - ch.from) / marks.end > 0.035 && <span>{ch.text}</span>}
            </span>
          ))}
        </ReviewSlider>
      </div>
      <Speed value={p.ms} options={[300, 600, 800, 1200]} unit={(n) => `1 回 ${n / 1000} 秒`} onChange={p.setMs} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
