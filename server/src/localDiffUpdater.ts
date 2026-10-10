import { Effect, Layer } from "effect";
import { DiffUpdater, ROOT_ID, type DiffInput, type DiffOutput, type DiffUpdateError, type Op } from "./core/index.ts";
import { classificationRequest, splitSentences, type Classification, type Sentence } from "./localPrompt.ts";

// 40字の要約3文と合意・作業の追加欄を600トークンで返す初期上限。
const SENTENCE_LIMIT = 3;
export type Classify = (request: ReturnType<typeof classificationRequest>) => Effect.Effect<Classification, DiffUpdateError>;
const blank = (text: string) => text.trim() === "" || /^(なし|無し|未定|不明|-|―|N\/A)$/i.test(text.trim());

function toOps(raw: Classification, sentences: readonly Sentence[], nextRef: () => string): Op[] {
  const ops: Op[] = [];
  let topic = raw.議題.id;
  const first = raw.文.findIndex((s) => s.種類 !== "なし");
  if (topic === "新しい議題") {
    topic = ROOT_ID;
    if (first !== -1 && raw.議題.題 !== "") {
      topic = nextRef();
      ops.push({ op: "add", ref: topic, parent: ROOT_ID, kind: "議題", text: raw.議題.題, evidence: [sentences[first]!.remark] });
    }
  }
  raw.文.forEach((s, i) => {
    if (s.種類 === "なし") return;
    const evidence = [sentences[i]!.remark];
    if (s.種類 === "合意") {
      let point = s.論点;
      if (point === "新しい論点") {
        point = nextRef();
        ops.push({ op: "add", ref: point, parent: topic, kind: "論点", text: s.論点の文 || s.text, evidence });
      }
      ops.push({ op: "add", ref: nextRef(), parent: point, kind: "決定", text: s.text, evidence });
    } else if (s.種類 === "作業") {
      ops.push({ op: "add", ref: nextRef(), parent: topic, kind: "TODO", text: s.text, evidence,
        ...(blank(s.担当) ? {} : { assignee: s.担当 }), ...(blank(s.期限) ? {} : { due: s.期限 }) });
    } else {
      const kinds = { 説明: "要点", 問い: "論点", 提案: "案", 懸念: "課題" } as const;
      ops.push({ op: "add", ref: nextRef(), parent: topic, kind: kinds[s.種類], text: s.text, evidence });
    }
  });
  if (raw.済み !== "なし" && raw.済み !== topic) ops.push({ op: "close", node: raw.済み });
  return ops;
}

export const localUpdaterLayer = (classify: Classify) => Layer.succeed(DiffUpdater, DiffUpdater.of({
  update: Effect.fnUntraced(function* ({ map, recent, fresh }: DiffInput): Effect.fn.Return<DiffOutput, DiffUpdateError> {
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
    let sequence = 0;
    for (let offset = 0; offset < selected.length; offset += SENTENCE_LIMIT) {
      const sentences = selected.slice(offset, offset + SENTENCE_LIMIT);
      const raw = yield* classify(classificationRequest(map, recent, sentences));
      ops.push(...toOps(raw, sentences, () => `新${++sequence}`));
    }
    return { ops, processedRemarks };
  }),
}));
