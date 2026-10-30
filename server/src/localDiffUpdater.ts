import { Effect, Layer } from "effect";
import { children, DiffUpdater, pointStatus, ROOT_ID, type DiffInput, type DiffOutput, type DiffUpdateError, type InferredSpeakerName, type KatakanaAsk, type MeetingMap, type Op } from "./core/index.ts";
import { classificationRequest, splitSentences, type Classification, type Sentence } from "./localPrompt.ts";

const SENTENCE_LIMIT = 3;
export type Classify = (request: ReturnType<typeof classificationRequest>) => Effect.Effect<Classification, DiffUpdateError>;
export type LocalModel = { readonly classify: Classify; readonly katakana: KatakanaAsk };
const blank = (text: string) => text.trim() === "" || /^(なし|無し|未定|不明|-|―|N\/A)$/i.test(text.trim());

function openPoints(map: MeetingMap, topic: string): string[] {
  return children(map, topic).filter((node) => !node.talkStatus).flatMap((node) => [
    ...(node.kind === "論点" && pointStatus(map, node.id) === "未決" ? [node.id] : []),
    ...openPoints(map, node.id),
  ]);
}

function proposalPoints(map: MeetingMap, topic: string, preceding: readonly Op[]): Set<string> {
  const points = new Set(openPoints(map, topic));
  for (const op of preceding) {
    if (op.op === "add" && op.kind === "論点" && op.parent === topic) points.add(op.ref);
    if (op.op === "add" && op.kind === "決定") points.delete(op.parent);
    if (op.op === "close") points.delete(op.node);
  }
  return points;
}

function workAssignment(s: Extract<Classification["文"][number], { 種類: "作業" }>) {
  return {
    ...(blank(s.担当) ? {} : { assignee: s.担当 }),
    ...(blank(s.担当の話者) ? {} : { assigneeSpeaker: s.担当の話者 }),
    ...(blank(s.期限) ? {} : { due: s.期限 }),
  };
}

function sentenceOps(s: Classification["文"][number], remarkId: string, topic: string, points: Set<string>, nextRef: () => string): Op[] {
  if (s.種類 === "なし") return [];
  const evidence = [remarkId];
  if (s.種類 === "合意") {
    const point = s.論点 === "新しい論点" ? nextRef() : s.論点;
    points.delete(point);
    return [
      ...(s.論点 === "新しい論点" ? [{ op: "add", ref: point, parent: topic, kind: "論点", text: s.論点の文 || s.text, evidence } satisfies Op] : []),
      { op: "add", ref: nextRef(), parent: point, kind: "決定", text: s.text, evidence },
    ];
  }
  if (s.種類 === "作業") return [{
    op: "add", ref: nextRef(), parent: topic, kind: "TODO", text: s.text, evidence,
    ...workAssignment(s),
  }];
  const kinds = { 説明: "要点", 問い: "論点", 提案: "案", 懸念: "課題" } as const;
  const parent = s.種類 === "提案" && points.size === 1 ? [...points][0]! : topic;
  const ref = nextRef();
  if (s.種類 === "問い") points.add(ref);
  return [{ op: "add", ref, parent, kind: kinds[s.種類], text: s.text, evidence }];
}

function toOps(raw: Classification, sentences: readonly Sentence[], map: MeetingMap, preceding: readonly Op[], nextRef: () => string): Op[] {
  const ops: Op[] = [];
  let topic = raw.議題.id;
  const first = raw.文.findIndex((s) => s.種類 !== "なし");
  if (topic === "新しい議題") {
    topic = ROOT_ID;
    if (first !== -1 && raw.議題.題 !== "") {
      topic = nextRef();
      const digression = raw.脱線?.find((item) => item.id === "新しい議題")?.digression;
      ops.push({ op: "add", ref: topic, parent: ROOT_ID, kind: "議題", text: raw.議題.題, evidence: [sentences[first]!.remark.id], ...(digression === undefined ? {} : { digression }) });
    }
  }
  const points = proposalPoints(map, topic, preceding);
  raw.文.forEach((s, i) => {
    ops.push(...sentenceOps(s, sentences[i]!.remark.id, topic, points, nextRef));
  });
  for (const item of raw.脱線 ?? []) {
    if (item.id !== "新しい議題") ops.push({ op: "update", node: item.id, digression: item.digression, evidence: [item.evidence] });
  }
  if (raw.済み !== "なし" && raw.済み !== topic) ops.push({ op: "close", node: raw.済み });
  return ops;
}

export const localUpdaterLayer = ({ classify, katakana }: LocalModel) => Layer.succeed(DiffUpdater, DiffUpdater.of({
  update: Effect.fnUntraced(function* ({ map, recent, fresh, speakerNames }: DiffInput): Effect.fn.Return<DiffOutput, DiffUpdateError> {
    let processedRemarks = 0;
    const selected: Sentence[] = [];
    for (const remark of fresh) {
      const sentences = splitSentences(remark);
      if (selected.length + sentences.length > SENTENCE_LIMIT && processedRemarks > 0) break;
      selected.push(...sentences);
      processedRemarks++;
      if (selected.length >= SENTENCE_LIMIT) break;
    }
    const ops: Op[] = [];
    const names: InferredSpeakerName[] = [];
    let sequence = 0;
    for (let offset = 0; offset < selected.length; offset += SENTENCE_LIMIT) {
      const sentences = selected.slice(offset, offset + SENTENCE_LIMIT);
      const raw = yield* classify(classificationRequest(map, recent, sentences, speakerNames));
      ops.push(...toOps(raw, sentences, map, ops, () => `新${++sequence}`));
      names.push(...raw.名前);
    }
    return { ops, processedRemarks, ...(names.length > 0 ? { names } : {}) };
  }),
  katakana,
}));
