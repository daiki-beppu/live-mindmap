// PROTOTYPE #764（使い捨て。main には入れない）: 途中結果から Jev が判定した「いま話している議題」を、見返し画面で光らせ方を変えて見比べる。
// 開き方: pnpm --filter @live-mindmap/web dev → http://localhost:5173/?proto764&variant=outline
// データは server/bench/_proto764/build-ui.mjs が web/proto764/ に作る（実測の反映時刻・途中結果・Jev の答え）
import { createContext, useContext, useEffect, useState } from "react";
import type { Speaking } from "./liveFeed.ts";
import { ReviewView } from "./ReviewView.tsx";

export const VARIANTS = {
  off: "今のまま（光らせない）",
  outline: "A 議題の枠を細く色づける",
  dim: "B ほかの議題を薄くする",
  caption: "C 字幕の頭に議題名",
  dot: "D 議題の脇に小さな点",
} as const;
export type Variant = keyof typeof VARIANTS;

type Highlight = { at: number; topic: string | null; hit: boolean | null };
export type ProtoData = { events: unknown[]; interim: { at: number; start: number; text: string }[]; highlights: Highlight[] };

// 光らせる議題の id と変種。MapView・MapNode・Captions が読む
export const Proto764 = createContext<{ variant: Variant; topic: string | null; hit: boolean | null; topicText: string | null } | null>(null);
export const useProto764 = () => useContext(Proto764);

// Jev の最後の答えから HOLD 秒たったら消す（話が途切れたのに光り続けないように）
const HOLD = 10;
export function highlightAt(data: ProtoData, t: number): Highlight | null {
  let cur: Highlight | null = null;
  for (const h of data.highlights) { if (h.at > t) break; cur = h; }
  return cur && cur.topic && t - cur.at < HOLD ? cur : null;
}

// 本番の字幕と同じく途中結果を出す（見返しは本来、発言の終わりで字幕を出す）。最後の更新から 3 秒で消す
export function interimSpeakingAt(data: ProtoData, t: number): Speaking {
  let cur: ProtoData["interim"][number] | undefined;
  for (const e of data.interim) { if (e.at > t) break; cur = e; }
  return { 相手: cur && t - cur.at < 3 ? cur.text.slice(-80) : "", 自分: "" };
}

export function Proto764Page() {
  const [data, setData] = useState<ProtoData | null>(null);
  useEffect(() => { void fetch("/proto764/data.json").then((r) => r.json()).then(setData); }, []);
  if (!data) return <p style={{ padding: 16 }}>読み込み中…（web/proto764/data.json）</p>;
  return <ReviewView events={data.events} audioUrl="/proto764/meeting.m4a" proto={data} />;
}

export function variantFromUrl(): Variant {
  const v = new URLSearchParams(location.search).get("variant");
  return v && v in VARIANTS ? (v as Variant) : "off";
}

// 画面の上の中央に置く切り替え（下端は字幕と再生の操作があるため）
export function Proto764Switcher({ current, hit }: { current: Variant; hit: boolean | null }) {
  const go = (v: Variant) => {
    const u = new URL(location.href);
    u.searchParams.set("variant", v);
    history.replaceState(null, "", u);
    dispatchEvent(new Event("proto764"));
  };
  return (
    <div className="proto764-switcher">
      <span className="proto764-switcher__label">試作 #764</span>
      {(Object.keys(VARIANTS) as Variant[]).map((v) => (
        <button key={v} type="button" className={v === current ? "is-current" : ""} onClick={() => go(v)}>{VARIANTS[v]}</button>
      ))}
      <span className="proto764-switcher__hit">{hit === null ? "" : hit ? "当たり" : "外れ"}</span>
    </div>
  );
}

export function useVariant(): Variant {
  const [v, setV] = useState(variantFromUrl);
  useEffect(() => {
    const on = () => setV(variantFromUrl());
    addEventListener("proto764", on);
    return () => removeEventListener("proto764", on);
  }, []);
  return v;
}
