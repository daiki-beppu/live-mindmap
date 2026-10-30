// PROTOTYPE（issue #1738、使い捨て。main には入れない）: 補足をノードの種別にするか、ノードに添えるかの 4 案。
// ?variant=A|B|C|D で切り替える（web/prototype-supplement.html）。補足の中身は合成会議の発言から手で書いた固定値で、モデルは呼ばない。
import type { Snapshot, SnapshotNode } from "../../../../server/src/core/index.ts";

export type Supplement = {
  // 添える先のノードの本文（反映の回が変わっても同じノードを指せるように、id ではなく本文で引く）
  readonly on: string;
  // 会議の中から分かる（理由・経緯）か、会議の外の知識か
  readonly source: "meeting" | "outside";
  readonly label: string;
  readonly text: string;
};

export const SUPPLEMENTS: readonly Supplement[] = [
  { on: "面接は2回にする", source: "meeting", label: "理由", text: "応募者と面接官の負担を減らすため（会議の目的、00:07）" },
  { on: "2回目だけ会社に来てもらう", source: "meeting", label: "理由", text: "1回目をオンラインにして、来社を1回に減らす（00:15）" },
  { on: "採用面接を何回にするか", source: "meeting", label: "経緯", text: "相手 B が 2 回を提案し、相手 A がそのまま決めた（00:11）" },
  { on: "1回目はオンラインで行う", source: "outside", label: "用語（会議の外）", text: "オンライン面接: ビデオ通話で行う面接。移動が要らず日程を合わせやすい" },
];

const variant = (): string => new URLSearchParams(globalThis.location?.search ?? "").get("variant") ?? "A";

export const supplementVariant = variant;

export const supplementOf = (node: SnapshotNode): Supplement | undefined => SUPPLEMENTS.find((s) => s.on === node.text);

const SUPPLEMENT_ID = "proto-sup-";
export const isSupplementNode = (node: SnapshotNode): boolean => node.id.startsWith(SUPPLEMENT_ID);
export const supplementOfNode = (node: SnapshotNode): Supplement | undefined =>
  isSupplementNode(node) ? SUPPLEMENTS[Number(node.id.slice(SUPPLEMENT_ID.length))] : undefined;

// 案 A: 補足を、添える先のノードの子のノードとして木に足す（種別は今ある「要点」を借り、見た目だけ変える）
export const withSupplementNodes = (snapshot: Snapshot): Snapshot => {
  if (variant() !== "A") return snapshot;
  const added = SUPPLEMENTS.flatMap((s, i) => {
    const target = snapshot.nodes.find((n) => n.text === s.on);
    if (target === undefined) return [];
    const node = { id: `${SUPPLEMENT_ID}${i}`, parent: target.id, kind: "要点", text: `${s.label}: ${s.text}`, evidence: target.evidence, evidenceRound: target.evidenceRound, ...(target.touchedAt === undefined ? {} : { touchedAt: target.touchedAt }) } as SnapshotNode;
    return [node];
  });
  return { ...snapshot, nodes: [...snapshot.nodes, ...added] };
};
