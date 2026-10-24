import { reviewSnapshot, SpeakerNameLogEvent, topicOf, type CaptionBubble, type LogEvent, type Remark, type Snapshot, type SpeakerNames } from "../../server/src/core/index.ts";
import { Schema } from "effect";

export const CAPTION_SECONDS = 8;

export type Reflection = { round: number; at: number; index: number };

export type ReviewTimeline = {
  events: readonly unknown[];
  remarks: readonly { remark: Remark; index: number }[];
  reflections: readonly Reflection[];
  reflectionTimes: readonly number[];
  speakerNames: SpeakerNames;
  duration: number;
  cache: Map<string, Snapshot>;
};

const isSpeakerNameLog = Schema.is(SpeakerNameLogEvent);

export function buildReviewTimeline(events: readonly unknown[]): ReviewTimeline {
  const remarks: { remark: Remark; index: number }[] = [];
  const reflections: Reflection[] = [];
  const byId = new Map<string, Remark>();
  let speakerNames: SpeakerNames = {};
  events.forEach((event, index) => {
    if (isSpeakerNameLog(event)) {
      speakerNames = { ...speakerNames, [event.label]: event.name };
      return;
    }
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
  return { events, remarks, reflections, reflectionTimes, speakerNames, duration, cache: new Map() };
}

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

export function captionBubblesAt(timeline: ReviewTimeline, t: number): CaptionBubble[] {
  return timeline.remarks
    .map(({ remark }) => remark)
    .filter((r) => r.end <= t && t - r.end < CAPTION_SECONDS && r.text.trim() !== "")
    .map((r): CaptionBubble => ({
      id: r.id,
      track: r.track,
      ...(r.speaker === undefined ? {} : { speaker: r.speaker }),
      label: r.speaker === undefined ? "なし" : "確定",
      start: r.start,
      end: r.end,
      text: r.text,
      settledLength: r.text.length,
    }))
    .sort((a, b) => a.start - b.start);
}

export function formatHms(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const h = Math.floor(total / 3600);
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${h}:${mm}:${ss}`;
}

export const MIN_CHAPTER_SECONDS = 45;

export type Chapter = { topic: string; name: string; start: number; end: number };

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

export function chapterNameAt(chapters: readonly Chapter[], t: number): string {
  const found = chapters.find((c) => c.start <= t && t < c.end) ?? (t >= (chapters[chapters.length - 1]?.end ?? Number.POSITIVE_INFINITY) ? chapters[chapters.length - 1] : undefined);
  return found?.name ?? "";
}

export type Mark = { at: number; kind: "決定" | "TODO" };

export function reviewMarks(timeline: ReviewTimeline): Mark[] {
  return snapshotAt(timeline, timeline.duration).changes.flatMap((c): Mark[] => {
    if (c.change === "決定済み化") return [{ at: c.at, kind: "決定" }];
    if (c.change === "追加" && (c.kind === "決定" || c.kind === "TODO")) return [{ at: c.at, kind: c.kind }];
    return [];
  });
}
