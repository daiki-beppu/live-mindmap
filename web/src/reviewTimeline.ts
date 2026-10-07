import { reviewSnapshot, topicOf, type LogEvent, type Remark, type Snapshot } from "../../server/src/core/index.ts";
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

// 章の最短の長さ（秒）。これより短い章は直前の章に含める
export const MIN_CHAPTER_SECONDS = 45;

// 議題ごとの章。topic は議題ノードの ID、name は最後の時点のその議題の text
export type Chapter = { topic: string; name: string; start: number; end: number };

// 最後の時点のスナップショットの changes から、議題が切り替わるところで区切る。
// 議題は変わったノード自身を含めて parent をたどった最初の議題（topicOf と同じ規則）。見つからない変化は飛ばす。
// 区切った後、45 秒未満の章と、直前の章と同じ議題の章は、直前の章に含める（直前の章の終わりを伸ばす）
export function reviewChapters(timeline: ReviewTimeline): Chapter[] {
  const { duration } = timeline;
  const snapshot = snapshotAt(timeline, duration);
  const map = { nodes: Object.fromEntries(snapshot.nodes.map((n) => [n.id, n])), order: snapshot.nodes.map((n) => n.id), nextId: 0 };
  const split: { topic: string; start: number; end: number }[] = [];
  for (const change of snapshot.changes) {
    const topic = topicOf(map, change.node);
    if (topic === undefined) continue;
    const current = split[split.length - 1];
    if (current?.topic === topic) continue;
    if (current) current.end = change.at;
    split.push({ topic, start: split.length === 0 ? 0 : change.at, end: duration });
  }
  const merged: { topic: string; start: number; end: number }[] = [];
  for (const chapter of split) {
    const previous = merged[merged.length - 1];
    if (previous && (chapter.end - chapter.start < MIN_CHAPTER_SECONDS || previous.topic === chapter.topic)) previous.end = chapter.end;
    else merged.push({ ...chapter });
  }
  return merged.map((c) => ({ ...c, name: map.nodes[c.topic]!.text }));
}

// ポインタの位置 t の章の名前。start ≤ t < end の章。t が会議の長さちょうどなら最後の章。章が無ければ空文字
export function chapterNameAt(chapters: readonly Chapter[], t: number): string {
  const found = chapters.find((c) => c.start <= t && t < c.end) ?? (t >= (chapters[chapters.length - 1]?.end ?? Number.POSITIVE_INFINITY) ? chapters[chapters.length - 1] : undefined);
  return found?.name ?? "";
}

// シークバーに置く目印。kind は点の色の引き先（決定済み化は決定の色）
export type Mark = { at: number; kind: "決定" | "TODO" };

// 決定・TODO の追加と、決定済み化だけを目印にする。時刻は反映の時刻（at）
export function reviewMarks(timeline: ReviewTimeline): Mark[] {
  return snapshotAt(timeline, timeline.duration).changes.flatMap((c): Mark[] => {
    if (c.change === "決定済み化") return [{ at: c.at, kind: "決定" }];
    if (c.change === "追加" && (c.kind === "決定" || c.kind === "TODO")) return [{ at: c.at, kind: c.kind }];
    return [];
  });
}
