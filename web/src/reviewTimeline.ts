import { reviewSnapshot, type LogEvent, type Remark, type Snapshot } from "../../server/src/core/index.ts";
import type { Speaking } from "./liveFeed.ts";

// 見返しの時間軸（純粋なモジュール）。ログの出来事の配列から、時刻 t のスナップショット・字幕・反映の時刻を導く。
// 時刻の軸は発言の end（会議の中の秒）。ログの at は使わない。

// 発言が字幕に出ている秒数。end からこの秒数が経つと消える
export const CAPTION_SECONDS = 8;

export type Reflection = { round: number; at: number; index: number }; // index は、出来事の配列の中での diff の位置

export type ReviewTimeline = {
  events: readonly unknown[];
  remarks: readonly { remark: Remark; index: number }[];
  reflections: readonly Reflection[];
  reflectionTimes: readonly number[]; // 反映の時刻。同じ時刻は 1 つにまとめた昇順
  duration: number;
  cache: Map<string, Snapshot>;
};

// 出来事を 1 回だけ順に見る。反映に数えるのは、restoreSession が round を進める条件と同じ error の無い diff だけ
export function buildReviewTimeline(events: readonly unknown[]): ReviewTimeline {
  const remarks: { remark: Remark; index: number }[] = [];
  const reflections: Reflection[] = [];
  const byId = new Map<string, Remark>();
  events.forEach((event, index) => {
    const e = event as LogEvent;
    if (e.type === "remark") {
      remarks.push({ remark: e.remark, index });
      byId.set(e.remark.id, e.remark);
    } else if (e.type === "diff" && e.error === undefined) {
      const ends = e.input.fresh.map((id) => byId.get(id)?.end ?? Number.NEGATIVE_INFINITY);
      reflections.push({ round: reflections.length + 1, at: Math.max(...ends), index });
    }
  });
  const reflectionTimes = [...new Set(reflections.map((r) => r.at))].sort((a, b) => a - b);
  const duration = Math.max(0, ...remarks.map((r) => r.remark.end), ...reflections.map((r) => r.at));
  return { events, remarks, reflections, reflectionTimes, duration, cache: new Map() };
}

// 時刻が t を超える最初の反映（ログの順）より前にある出来事で、発言は end ≤ t のものだけ。
// 同じ区間（残る反映の数と発言の数が同じ）では同じオブジェクトを返す
export function snapshotAt(timeline: ReviewTimeline, t: number): Snapshot {
  const { events, remarks, reflections } = timeline;
  const firstLater = reflections.find((r) => r.at > t);
  const cutoff = firstLater?.index ?? events.length;
  const keptReflections = firstLater ? reflections.indexOf(firstLater) : reflections.length;
  const keptRemarkIds = new Set(remarks.filter((r) => r.index < cutoff && r.remark.end <= t).map((r) => r.remark.id));
  const key = `${keptReflections}:${keptRemarkIds.size}`;
  const cached = timeline.cache.get(key);
  if (cached) return cached;
  const kept = events.slice(0, cutoff).flatMap((event) => {
    const e = event as LogEvent;
    if (e.type === "remark") return keptRemarkIds.has(e.remark.id) ? [event] : [];
    // error のある diff は ops が空なので、残した発言だけに絞った写しを渡しても、マップは変わらない
    if (e.type === "diff" && e.error !== undefined) return [{ ...e, input: { ...e.input, fresh: e.input.fresh.filter((id) => keptRemarkIds.has(id)) } }];
    return [event];
  });
  const snapshot = reviewSnapshot(kept);
  timeline.cache.set(key, snapshot);
  return snapshot;
}

export function topicNameOf(snapshot: Snapshot): string {
  return snapshot.nodes.find((n) => n.id === snapshot.currentTopic)?.text ?? "";
}

// トラックごとに、end ≤ t で最も遅い発言の本文を、t − end が CAPTION_SECONDS 未満の間だけ出す
export function speakingAt(timeline: ReviewTimeline, t: number): Speaking {
  const latest = (track: Remark["track"]) => {
    let best: Remark | undefined;
    for (const { remark } of timeline.remarks) if (remark.track === track && remark.end <= t && (!best || remark.end >= best.end)) best = remark;
    return best && t - best.end < CAPTION_SECONDS ? best.text : "";
  };
  return { 相手: latest("相手"), 自分: latest("自分") };
}

export function formatHms(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const h = Math.floor(total / 3600);
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${h}:${mm}:${ss}`;
}
