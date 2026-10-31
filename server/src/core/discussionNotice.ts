import { Schema } from "effect";
import { kidsOf, pointStatusOf, type MapNode, type MeetingMap } from "./map.ts";
import { earliestRemark, type Remark } from "./remark.ts";

export const DISCUSSION_NOTICE_SECONDS = 10 * 60;
export const DISCUSSION_NOTICE_CHILDREN = 3;
export const DISCUSSION_NOTICE_INTERVAL = 5 * 60;

export const DiscussionNoticeFrame = Schema.Struct({ type: Schema.Literal("discussion-notice"), text: Schema.NullOr(Schema.String) });
export const DiscussionNoticeEvent = Schema.Struct({ type: Schema.Literal("discussion-notice"), pointId: Schema.String, at: Schema.Finite, text: Schema.String });
export type DiscussionNoticeEvent = typeof DiscussionNoticeEvent.Type;

type Period =
  | { readonly status: "inactive"; readonly children: ReadonlySet<string> }
  | { readonly status: "active"; readonly origin: "evidence" | "reopened"; readonly since: number; readonly baseline: ReadonlySet<string>; readonly children: ReadonlySet<string>; readonly notified: boolean; readonly readyAt: number | undefined };
export type DiscussionNoticeState = { readonly points: ReadonlyMap<string, Period>; readonly lastAt: number | undefined };

export const createDiscussionNoticeState = (): DiscussionNoticeState => ({ points: new Map(), lastAt: undefined });

function observePoint(previous: Period | undefined, node: MapNode, kids: readonly MapNode[], remarks: ReadonlyMap<string, Remark>, at: number): Period | undefined {
  const currentChildren = new Set(kids.map((child) => child.id));
  if (node.talkStatus === "済み" || pointStatusOf(kids) === "決定済み") return { status: "inactive", children: currentChildren };
  const first = earliestRemark(node.evidence, remarks);
  if (first === undefined) return;
  const active: Extract<Period, { status: "active" }> = previous?.status === "active" ? previous : {
    status: "active", origin: previous === undefined ? "evidence" : "reopened", since: previous === undefined ? first.start : at,
    baseline: previous?.children ?? new Set<string>(), children: new Set<string>(), notified: false, readyAt: undefined,
  };
  const since = active.origin === "evidence" ? first.start : active.since;
  const seen = new Set([...active.children, ...active.baseline, ...currentChildren]);
  const ready = at - since >= DISCUSSION_NOTICE_SECONDS && seen.size - active.baseline.size >= DISCUSSION_NOTICE_CHILDREN;
  return { ...active, since, children: seen, readyAt: ready ? active.readyAt ?? at : undefined };
}

export function observeDiscussion(state: DiscussionNoticeState, map: MeetingMap, remarks: ReadonlyMap<string, Remark>, at: number): DiscussionNoticeState {
  const kids = kidsOf(map);
  const points = new Map<string, Period>();
  for (const id of map.order) {
    const node = map.nodes[id]!;
    if (node.kind !== "論点") continue;
    const period = observePoint(state.points.get(id), node, kids.get(id) ?? [], remarks, at);
    if (period !== undefined) points.set(id, period);
  }
  return { ...state, points };
}

export function nextDiscussionNotice(state: DiscussionNoticeState, map: MeetingMap, at: number, criteria: readonly string[]): DiscussionNoticeEvent | undefined {
  if (state.lastAt !== undefined && at - state.lastAt < DISCUSSION_NOTICE_INTERVAL) return;
  const eligible = map.order.flatMap((id) => {
    const period = state.points.get(id);
    return period?.status === "active" && !period.notified && period.readyAt !== undefined ? [{ id, period }] : [];
  }).sort((a, b) => a.period.readyAt! - b.period.readyAt!);
  const selected = eligible[0];
  if (selected === undefined) return;
  const minutes = Math.floor((at - selected.period.since) / 60);
  const advice = criteria.length === 0 ? "何を重視して決めるかを先に確かめませんか" : `判断軸${criteria.map((axis) => `「${axis}」`).join("")}で決められそうですか`;
  return { type: "discussion-notice", pointId: selected.id, at, text: `「${map.nodes[selected.id]!.text}」が ${minutes} 分決まっていません。${advice}` };
}

export function recordDiscussionNotice(state: DiscussionNoticeState, event: DiscussionNoticeEvent): DiscussionNoticeState {
  const period = state.points.get(event.pointId);
  if (period?.status !== "active") throw new Error(`通知の対象期間がありません: ${event.pointId}`);
  return { points: new Map(state.points).set(event.pointId, { ...period, notified: true }), lastAt: event.at };
}
