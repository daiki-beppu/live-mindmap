// PROTOTYPE（使い捨て。main に入れない）: 字幕での話者ラベルの見せ方（issue #372）
// 「ライブ画面の上で、話者ラベルの出し方 3 案を ?variant=A|B|C で切り替え、筋書きの会議を流して見比べる」
// 開き方: pnpm --filter @live-mindmap/web dev → http://localhost:5173/?prototype=speaker-captions
// 時刻 t から字幕の状態を決める純粋な関数（stateAt）を使うので、シークバーで任意の時点に戻して見られる。
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Snapshot } from "../../server/src/core/index.ts";
import { SessionView } from "./SessionView.tsx";

type Track = "相手" | "自分";
type Spk = "A" | "B" | "C";

// ---- 筋書き（架空の会議）。turn ごとに話者と本文、区間。prov は仮ラベルが誤る場合、conf: null は確定ラベルが来ない場合 ----
type Turn = { track: Track; spk?: Spk; start: number; end: number; text: string; prov?: Spk | null; conf?: Spk | null };
const SCRIPT: Turn[] = [
  { track: "相手", spk: "A", start: 0.5, end: 4.0, text: "来週のリリースの件ですけど、テストはどこまで終わってますか。" },
  { track: "相手", spk: "B", start: 4.4, end: 8.6, text: "結合テストは昨日終わりました。残りは負荷試験だけです。" },
  { track: "相手", spk: "A", start: 8.8, end: 9.6, text: "なるほど。" },
  // 仮ラベルは B と出るが、確定は C（仮の取り違え）
  { track: "相手", spk: "C", start: 9.8, end: 13.4, text: "負荷試験は私のほうで今週中にやります。", prov: "B" },
  { track: "自分", start: 13.8, end: 16.4, text: "じゃあ金曜に結果を見ましょう。" },
  // B が話し終わる前に A が間を空けずに続ける（1 つの途中結果の中で話者が替わる）
  { track: "相手", spk: "B", start: 16.8, end: 20.2, text: "それと、告知の文面はまだ決まってないですよね。" },
  { track: "相手", spk: "A", start: 20.25, end: 22.4, text: "まだです、明日には出します。" },
  // 確定ラベルが 3 秒たっても来ない（話者なしで出す）
  { track: "相手", spk: "C", start: 23.2, end: 26.8, text: "すみません、少し音が途切れていたかもしれません。", prov: null, conf: null },
  { track: "相手", spk: "C", start: 27.4, end: 32.0, text: "では最後に一点だけ。予算の見直しは来月に回します。" },
  { track: "自分", start: 32.4, end: 34.0, text: "了解です、ありがとうございます。" },
];
const DURATION = 40;

type Word = { id: number; turn: number; track: Track; ws: number; we: number; text: string; prov: Spk | null; conf: Spk | null; turnEnd: number; sentenceEnd: boolean };

// 本文を 2〜4 文字の語に切り、区間に等分に並べる（STT の語の区間の代わり）
function wordsOf(script: Turn[]): Word[] {
  const words: Word[] = [];
  script.forEach((turn, ti) => {
    const pieces = turn.text.match(/[^、。]{1,4}[、。]?/g) ?? [];
    const step = (turn.end - turn.start) / pieces.length;
    pieces.forEach((p, i) => {
      words.push({
        id: words.length,
        turn: ti,
        track: turn.track,
        ws: turn.start + step * i,
        we: turn.start + step * (i + 1),
        text: p,
        prov: turn.prov === undefined || (turn.prov !== null && i >= 1) ? (turn.spk ?? null) : turn.prov,
        conf: turn.conf === undefined ? (turn.spk ?? null) : turn.conf,
        turnEnd: turn.end,
        sentenceEnd: p.endsWith("。"),
      });
    });
  });
  return words;
}
const WORDS = wordsOf(SCRIPT);

// ---- 時刻 t の状態 ----
type Params = { sttLag: number; provLag: number; confLag: number; useProv: boolean };
const DEFAULTS: Params = { sttLag: 0.4, provLag: 0.5, confLag: 0.9, useProv: true };
// 1 秒の無音で発言を締め、マップへの反映（QUIET 1.5 秒 + 差分更新の呼び出し）で字幕から消えるまでの時間
const REFLECT_AFTER = 1.0 + 1.5 + 3.0;
const GIVE_UP = 3.0;

type LabelState = "pending" | "provisional" | "confirmed" | "none";
type ShownWord = Word & { label: LabelState; spk: Spk | null };

function labelAt(w: Word, t: number, p: Params): { label: LabelState; spk: Spk | null } {
  if (w.track === "自分") return { label: "confirmed", spk: null };
  if (w.conf !== null && t >= w.we + p.confLag) return { label: "confirmed", spk: w.conf };
  if (w.conf === null && t >= w.turnEnd + GIVE_UP) return { label: "none", spk: null };
  if (p.useProv && w.prov !== null && t >= w.we + p.provLag) return { label: "provisional", spk: w.prov };
  return { label: "pending", spk: null };
}

// トラックごとに、見えている語（反映済みの発言は消える）を、末尾 2 文だけ残して返す（captions.ts の CAPTION_LINES と同じ）
function shownAt(track: Track, t: number, p: Params): ShownWord[] {
  const visible = WORDS.filter((w) => w.track === track && t >= w.we + p.sttLag && t < w.turnEnd + REFLECT_AFTER).map((w) => ({ ...w, ...labelAt(w, t, p) }));
  let sentences = 0;
  let from = 0;
  for (let i = visible.length - 1; i >= 0; i--) {
    if (visible[i]!.sentenceEnd && i !== visible.length - 1) {
      sentences++;
      if (sentences === 2) {
        from = i + 1;
        break;
      }
    }
  }
  return visible.slice(from);
}

// ---- 案 ----
const LETTER_COLOR: Record<Spk, string> = { A: "#2563eb", B: "#b45309", C: "#047857" };
const labelText = (w: ShownWord) => (w.spk ? `相手 ${w.spk}` : "相手");

// 連続する語を、出す話者（spk と状態）でまとめる。pending の語は直前のまとまりに付ける
type Run = { spk: Spk | null; label: LabelState; words: ShownWord[] };
function runsOf(words: ShownWord[]): Run[] {
  const runs: Run[] = [];
  for (const w of words) {
    const last = runs.at(-1);
    if (last && (w.label === "pending" || (last.spk === w.spk && (last.label === "none") === (w.label === "none")))) {
      last.words.push(w);
      if (w.label !== "pending" && last.label === "pending") Object.assign(last, { spk: w.spk, label: w.label });
    } else runs.push({ spk: w.spk, label: w.label, words: [w] });
  }
  return runs;
}

// A: 話者が替わったら行を分け、行頭の固定幅の欄に「相手 A」。仮は薄い灰、確定は今の track 表示と同じ灰
function VariantA({ them, me }: { them: ShownWord[]; me: ShownWord[] }) {
  return (
    <div className="captions" aria-live="polite">
      {them.length > 0 && (
        <div className="captions__block proto-a__block">
          {runsOf(them).map((r, i) => (
            <div key={`${i}-${r.words[0]!.id}`} className="proto-a__row">
              <span className={`captions__track proto-a__label proto-label--${r.label}`}>{r.label === "pending" ? "相手" : labelText(r.words.find((w) => w.label !== "pending") ?? r.words[0]!)}</span>
              <p className="captions__line">{r.words.map((w) => w.text).join("")}</p>
            </div>
          ))}
        </div>
      )}
      {me.length > 0 && <MeBlock me={me} />}
    </div>
  );
}

// B: 行は今と同じ（トラックごとに 1 ブロック）。話者が替わった語の前にだけ小さな「A」を差し込む。
// 文字は流れたまま。印は仮のうちは薄く、確定で灰になる
function VariantB({ them, me }: { them: ShownWord[]; me: ShownWord[] }) {
  return (
    <div className="captions" aria-live="polite">
      {them.length > 0 && (
        <div className="captions__block">
          <span className="captions__track">相手</span>
          <p className="captions__line">
            {runsOf(them).map((r, i) => (
              <span key={`${i}-${r.words[0]!.id}`}>
                {r.spk !== null && r.label !== "pending" && <span className={`proto-b__mark proto-label--${r.label}`}>{r.spk}</span>}
                {r.words.map((w) => w.text).join("")}
              </span>
            ))}
          </p>
        </div>
      )}
      {me.length > 0 && <MeBlock me={me} />}
    </div>
  );
}

// C: 文字には何も差し込まない。語ごとに文字の色で話者を分ける（ラベルが届く前は今の灰、仮は薄い色、確定で色）。
// 左の欄は「相手」の後ろに、いま話している（最後の語の）話者の文字だけを固定幅で出す
function VariantC({ them, me }: { them: ShownWord[]; me: ShownWord[] }) {
  const current = [...them].reverse().find((w) => w.spk !== null && w.label !== "pending");
  return (
    <div className="captions" aria-live="polite">
      {them.length > 0 && (
        <div className="captions__block">
          <span className="captions__track proto-c__label">
            相手 <span className={`proto-c__current proto-label--${current?.label ?? "pending"}`} style={current?.spk ? { color: LETTER_COLOR[current.spk] } : undefined}>{current?.spk ?? ""}</span>
          </span>
          <p className="captions__line">
            {them.map((w) => (
              <span key={w.id} className={`proto-c__word proto-c__word--${w.label}`} style={w.spk ? { color: LETTER_COLOR[w.spk] } : undefined}>
                {w.text}
              </span>
            ))}
          </p>
        </div>
      )}
      {me.length > 0 && <MeBlock me={me} />}
    </div>
  );
}

// D: A を元に、吹き出しで左右に分ける。相手（A/B/C）は左寄せ、自分は右寄せ。トラックをまたいで話し始めの順に 1 列に並べ、
// 末尾 BUBBLES 個だけ出す。話者の欄は吹き出しの上に小さく。枠は細い線だけ（影・塗りの強い色は付けない）
const BUBBLES = 3;
function VariantD({ them, me }: { them: ShownWord[]; me: ShownWord[] }) {
  const bubbles = [...runsOf(them).map((r) => ({ ...r, track: "相手" as Track })), ...(me.length > 0 ? runsByTurn(me) : [])]
    .sort((a, b) => a.words[0]!.ws - b.words[0]!.ws)
    .slice(-BUBBLES);
  if (bubbles.length === 0) return null;
  return (
    <div className="captions proto-d" aria-live="polite">
      {bubbles.map((r, i) => {
        const shown = r.words.find((w) => w.label !== "pending");
        return (
          <div key={`${i}-${r.words[0]!.id}`} className={`proto-d__row proto-d__row--${r.track === "自分" ? "me" : "them"}`}>
            <span className={`proto-d__label proto-label--${r.label}`}>{r.track === "自分" ? "自分" : r.label === "pending" || !shown ? "相手" : labelText(shown)}</span>
            <p className="proto-d__bubble">{r.words.map((w) => w.text).join("")}</p>
          </div>
        );
      })}
    </div>
  );
}
function sideOf(r: Run & { track: Track }, _them: ShownWord[], _me: boolean): boolean {
  const first = r.words[0]!;
  // 筋書きの turn を話者のまとまりとみなし、その turn より前で話者が替わった回数を数える（実装では確定ラベルで数える）
  let changes = 0;
  for (let i = 1; i <= first.turn; i++) {
    const a = SCRIPT[i - 1]!;
    const b = SCRIPT[i]!;
    // 話者なしで出た発言（確定ラベルが来なかった）は、前後と別の人として数える（画面に出た名前で替わり目を決める）
    const who = (x: Turn, j: number) => (x.conf === null ? `none-${j}` : `${x.track}-${x.spk ?? ""}`);
    if (who(a, i - 1) !== who(b, i)) changes++;
  }
  return changes % 2 === 1;
}

function runsByTurn(words: ShownWord[]): (Run & { track: Track })[] {
  const out: (Run & { track: Track })[] = [];
  for (const w of words) {
    const last = out.at(-1);
    if (last && last.words.at(-1)!.turn === w.turn) last.words.push(w);
    else out.push({ spk: null, label: "confirmed", words: [w], track: "自分" });
  }
  return out;
}

// E: D の気になる点を直したもの。
// - 相手の名前は吹き出しの左の固定幅の欄に置き、名前の文字だけ話者ごとの控えめな色。自分には名前を付けない（右寄せで分かる）
// - 同じ人が続く吹き出しでは名前を省く。ラベルの行が無いので、吹き出し 1 つの高さは A の 1 行と同じ
// - ラベルが届くまで（最大 HOLD 秒）語を出さない。出した語が後から別の吹き出しへ移らない
// - 吹き出しの幅は固定。動くときは跳ばさず 250ms で滑らせる（FLIP）
const HOLD = 0.6;
const GAP = 0.3;
function runsHeld(words: ShownWord[]): Run[] {
  const runs: Run[] = [];
  for (const w of words) {
    const last = runs.at(-1);
    const prev = last?.words.at(-1);
    const near = prev !== undefined && w.ws - prev.we < GAP;
    const neutral = (l: LabelState) => l === "pending" || l === "none";
    const join = last && (w.label === "pending" ? near || neutral(last.label) : last.spk === w.spk && neutral(last.label) === neutral(w.label) || (neutral(last.label) && last.spk === null && w.label === "none"));
    if (last && join) {
      last.words.push(w);
      if (last.label === "pending" && w.label !== "pending") Object.assign(last, { spk: w.spk, label: w.label });
    } else runs.push({ spk: w.spk, label: w.label, words: [w] });
  }
  return runs;
}
const SOFT_COLOR: Record<Spk, string> = { A: "#3b6fd4", B: "#a8641c", C: "#2f7d63" };
function VariantE(props: { them: ShownWord[]; me: ShownWord[]; t: number; p: Params }) {
  return <Bubbles {...props} alternate={false} />;
}
// F: E と同じ吹き出しで、左右を「話者が替わるたびに入れ替える」。自分かどうかは問わない。
// 側は会議の初めから数えた替わり目の数の偶奇で決めるので、古い吹き出しが消えても残りの側は変わらない
function VariantF(props: { them: ShownWord[]; me: ShownWord[]; t: number; p: Params }) {
  return <Bubbles {...props} alternate={true} />;
}
function Bubbles({ them, me, t, p, alternate }: { them: ShownWord[]; me: ShownWord[]; t: number; p: Params; alternate: boolean }) {
  const held = them.filter((w) => w.label !== "pending" || t >= w.we + p.sttLag + HOLD);
  const bubbles = [...runsHeld(held).map((r) => ({ ...r, track: "相手" as Track })), ...(me.length > 0 ? runsByTurn(me) : [])]
    .sort((a, b) => a.words[0]!.ws - b.words[0]!.ws)
    .slice(-BUBBLES);
  const ref = useRef<HTMLDivElement>(null);
  const tops = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const next = new Map<string, number>();
    const base = ref.current?.getBoundingClientRect().top ?? 0;
    for (const el of ref.current?.querySelectorAll<HTMLElement>("[data-key]") ?? []) {
      const key = el.dataset.key!;
      const top = base + el.offsetTop;
      next.set(key, top);
      const before = tops.current.get(key);
      if (before === undefined) {
        el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200 });
      } else if (Math.abs(before - top) > 0.5) {
        for (const a of el.getAnimations()) a.cancel();
        el.animate([{ transform: `translateY(${before - top}px)` }, { transform: "translateY(0)" }], { duration: 250, easing: "ease-out" });
      }
    }
    tops.current = next;
  });
  if (bubbles.length === 0) return null;
  return (
    <div ref={ref} className={`captions proto-e${alternate ? " proto-e--alt" : ""}`} style={{ position: "absolute" }} aria-live="polite">
      {bubbles.map((r, i) => {
        const me = r.track === "自分";
        const prev = bubbles[i - 1];
        const shown = r.words.find((w) => w.label !== "pending");
        const same = prev && prev.track === r.track && prev.spk === r.spk && (r.spk !== null || me);
        const right = alternate ? sideOf(r, them, me) : me;
        const name = me ? "自分" : shown?.spk ? `相手 ${shown.spk}` : "相手";
        const label = (alternate || !me) && (
          <span className={`proto-e__label proto-label--${r.label}`} style={shown?.spk ? { color: SOFT_COLOR[shown.spk] } : undefined}>
            {same ? "" : name}
          </span>
        );
        return (
          <div key={`${r.track}-${r.words[0]!.id}`} data-key={`${r.track}-${r.words[0]!.id}`} className={`proto-e__row proto-e__row--${right ? "me" : "them"}`}>
            {!right && label}
            <p className="proto-e__bubble">{r.words.map((w) => w.text).join("")}</p>
            {right && label}
          </div>
        );
      })}
    </div>
  );
}

function MeBlock({ me }: { me: ShownWord[] }) {
  return (
    <div className="captions__block">
      <span className="captions__track">自分</span>
      <p className="captions__line">{me.map((w) => w.text).join("")}</p>
    </div>
  );
}

const VARIANTS = { A: ["行頭ラベル・行を分ける", VariantA], B: ["替わり目に小さな印", VariantB], C: ["文字の色だけ", VariantC], D: ["A を吹き出しで左右に", VariantD], E: ["D の改善", VariantE], F: ["E を左右交互に", VariantF] } as const;
type VariantKey = keyof typeof VARIANTS;
const KEYS = Object.keys(VARIANTS) as VariantKey[];

// ---- 背景のマップ（固定） ----
const SNAPSHOT: Snapshot = {
  nodes: [
    { id: "root", parent: null, kind: "会議", text: "リリース前の確認", evidence: [] },
    { id: "t1", parent: "root", kind: "議題", text: "来週のリリース", evidence: ["r1"] },
    { id: "p1", parent: "t1", kind: "論点", text: "テストはどこまで終わったか", evidence: ["r1"], pointStatus: "未決" },
    { id: "k1", parent: "p1", kind: "要点", text: "結合テストは完了、残りは負荷試験", evidence: ["r2"] },
    { id: "d1", parent: "t1", kind: "TODO", text: "負荷試験を今週中に実施", evidence: ["r2"] },
  ],
  round: 2,
  changes: [
    { round: 1, at: 4.0, change: "追加", node: "p1", kind: "論点", text: "テストはどこまで終わったか" },
    { round: 2, at: 8.6, change: "追加", node: "k1", kind: "要点", text: "結合テストは完了、残りは負荷試験" },
  ],
  remarks: [
    { id: "r1", track: "相手", start: 0.5, end: 4.0, text: SCRIPT[0]!.text },
    { id: "r2", track: "相手", start: 4.4, end: 8.6, text: SCRIPT[1]!.text },
  ],
};
const EMPTY = { 相手: "", 自分: "" };

function readVariant(): VariantKey {
  const v = new URLSearchParams(location.search).get("variant");
  return KEYS.includes(v as VariantKey) ? (v as VariantKey) : "A";
}

export function PrototypeSpeakerCaptions() {
  const [variant, setVariant] = useState<VariantKey>(readVariant);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [rate, setRate] = useState(1);
  const [p, setP] = useState<Params>(DEFAULTS);

  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    const id = setInterval(() => {
      const now = performance.now();
      setT((x) => (x + ((now - last) / 1000) * rate) % DURATION);
      last = now;
    }, 50);
    return () => clearInterval(id);
  }, [playing, rate]);

  const go = (dir: 1 | -1) => {
    const next = KEYS[(KEYS.indexOf(variant) + dir + KEYS.length) % KEYS.length]!;
    const url = new URL(location.href);
    url.searchParams.set("variant", next);
    history.replaceState(null, "", url);
    setVariant(next);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input,textarea,[contenteditable]")) return;
      if (e.key === "[") go(-1);
      if (e.key === "]") go(1);
      if (e.key === " " && e.shiftKey) setPlaying((x) => !x);
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  });

  const them = useMemo(() => shownAt("相手", t, p), [t, p]);
  const me = useMemo(() => shownAt("自分", t, p), [t, p]);
  const [name, View] = VARIANTS[variant];

  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      <SessionView snapshot={SNAPSHOT} speaking={EMPTY} />
      <View them={them} me={me} t={t} p={p} />
      <div className="proto-bar">
        <button onClick={() => go(-1)}>←</button>
        <b>
          {variant}（{name}）
        </b>
        <button onClick={() => go(1)}>→</button>
        <span className="proto-bar__sep" />
        <button onClick={() => setPlaying((x) => !x)}>{playing ? "停止" : "再生"}</button>
        <input type="range" min={0} max={DURATION} step={0.05} value={t} onChange={(e) => setT(Number(e.target.value))} />
        <span className="proto-bar__num">{t.toFixed(1)}s</span>
        <select value={rate} onChange={(e) => setRate(Number(e.target.value))}>
          {[0.25, 0.5, 1].map((r) => (
            <option key={r} value={r}>
              ×{r}
            </option>
          ))}
        </select>
        <span className="proto-bar__sep" />
        <label>
          <input type="checkbox" checked={p.useProv} onChange={(e) => setP({ ...p, useProv: e.target.checked })} /> 仮ラベルを使う
        </label>
        <label>
          確定の遅れ
          <input type="number" min={0.2} max={3} step={0.1} value={p.confLag} onChange={(e) => setP({ ...p, confLag: Number(e.target.value) })} />s
        </label>
      </div>
      <StatePanel them={them} t={t} />
    </div>
  );
}

// いまの状態（語ごとのラベルの状態）。見比べの手がかり
function StatePanel({ them, t }: { them: ShownWord[]; t: number }) {
  return (
    <div className="proto-state">
      <div>
        t = {t.toFixed(2)}s ／ 相手の語 {them.length}
      </div>
      {them.map((w) => (
        <div key={w.id} className={`proto-label--${w.label}`}>
          {w.text} — {w.label}
          {w.spk ? ` ${w.spk}` : ""}
          {w.conf !== null && w.prov !== w.conf ? `（正解 ${w.conf}）` : ""}
        </div>
      ))}
    </div>
  );
}
