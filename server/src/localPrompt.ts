import { Schema } from "effect";
import { children, ROOT_ID, type DiffInput, type MeetingMap, type Remark } from "./core/index.ts";

export const SYSTEM = `あなたは会議のマインドマップに、新しい発言の内容を書き足す係です。
新しい発言は文に切って、番号付きで並べてあります。文ごとに種類を1つ選び、並べた順に返してください。
現在のマップには話し中の議題と論点だけを見せます。

種類:
- なし: 相づち・返事・段取り。「はい」「わかりました」「お願いします」「画面を出しますね」「次へ」
- 説明: 事実・数字・状況・経緯の共有
- 問い: 会議で答えを出すべき問いを投げかけた
- 提案: 「〜してはどうか」「〜という手もある」と、やり方の候補を出した
- 懸念: 問題やリスクの指摘
- 合意: 会議として結論を出した。「〜にしましょう」「〜は外す」「〜で決まり」。提案や意見の段階は合意ではない
- 作業: 会議の後にやる作業を引き受けた、または頼まれた。担当は話し手か頼んだ相手（分からなければ空文字）、期限は文に出たもの（無ければ空文字）

なし以外ではtextに40字以内で中身を要約する。合意では答えている論点のidを選び、無ければ「新しい論点」を選んで論点の文に問いを書く。
議題: 話し中の議題のidを選ぶ。話題が変わったら「新しい議題」を選び、題に20字以内の議題名を書く。
済み: 話が終わって戻らない議題・論点のidを1つ。ほとんどの回は「なし」。`;

export type Sentence = { readonly remark: string; readonly text: string };
export const splitSentences = (remark: Remark): Sentence[] =>
  remark.text.split(/(?<=[。？！?!])/).map((text) => text.trim()).filter(Boolean).map((text) => ({ remark: remark.id, text }));

const summary = Schema.NonEmptyString.check(Schema.isMaxLength(40));
const sentenceSchema = (points: readonly string[]) => Schema.Union([
  Schema.Struct({ 種類: Schema.Literal("なし") }),
  Schema.Struct({ 種類: Schema.Literals(["説明", "問い", "提案", "懸念"]), text: summary }),
  Schema.Struct({ 種類: Schema.Literal("合意"), 論点: Schema.Literals([...points, "新しい論点"]), 論点の文: Schema.String.check(Schema.isMaxLength(40)), text: summary }),
  Schema.Struct({ 種類: Schema.Literal("作業"), 担当: Schema.String, 期限: Schema.String, text: summary }),
]);
export type Classification = {
  readonly 議題: { readonly id: string; readonly 題: string };
  readonly 文: readonly ReturnType<typeof sentenceSchema>["Type"][];
  readonly 済み: string;
};

export function classificationRequest(map: MeetingMap, recent: DiffInput["recent"], sentences: readonly Sentence[]) {
  const topics: string[] = [], points: string[] = [], closable: string[] = [];
  const lines = [`- root 会議: ${map.nodes[ROOT_ID]!.text}`];
  const walk = (id: string, depth: number) => {
    for (const node of children(map, id)) {
      if (node.talkStatus || (node.kind !== "議題" && node.kind !== "論点")) continue;
      lines.push(`${"  ".repeat(depth)}- ${node.id} ${node.kind}: ${node.text}`);
      (node.kind === "議題" ? topics : points).push(node.id);
      closable.push(node.id);
      walk(node.id, depth + 1);
    }
  };
  walk(ROOT_ID, 1);
  const schema = Schema.Struct({
    議題: Schema.Struct({ id: Schema.Literals([...topics, "新しい議題"]), 題: Schema.String.check(Schema.isMaxLength(20)) }),
    文: Schema.Array(sentenceSchema(points)).check(Schema.isMinLength(sentences.length), Schema.isMaxLength(sentences.length)),
    済み: Schema.Literals(["なし", ...closable]),
  });
  const prompt = [
    "## 現在のマップ（話し中の部分）", lines.join("\n"), "",
    "## 直前の発言（処理済み・文脈用）", recent.length ? recent.map((r) => `${r.id} [${r.start}] ${r.text}`).join("\n") : "（なし）", "",
    `## 新しい発言（${sentences.length} 文）`, sentences.map((s, i) => `${i + 1}. [${s.remark}] ${s.text}`).join("\n"),
  ].join("\n");
  return { prompt, schema, jsonSchema: Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" }).schema };
}
