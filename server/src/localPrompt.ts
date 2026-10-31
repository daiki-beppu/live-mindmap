import { Schema } from "effect";
import { children, emptyMap, InferredSpeakerName, ROOT_ID, type DiffInput, type MeetingMap, type Remark } from "./core/index.ts";
import { nameOfSpeaker, remarkLine } from "./remarkLine.ts";

export const SYSTEM = `あなたは会議のマインドマップに、新しい発言の内容を書き足す係です。
新しい発言は文に切って、番号付きで並べてあります。文ごとに種類を1つ選び、並べた順に返してください。
現在のマップには話し中の議題と論点を見せます。別に、マップに添えられた種別「補足」の一覧を、親の情報とともに見せます。

補足: 発言の要点とは別に添えられた説明。会議の中で誤りだと言われたときだけ、その補足のidを「補足の削除」の配列に入れて消す。指摘されていない補足は残し、削除がなければ省略してよい。文が「なし」でも削除が必要なら返す。
補足は差分更新では作らない。補足に子を付けない。補足に根拠を足さない。補足の本文変更・移動・統合もしない。

種類:
- なし: 相づち・返事・段取り。「はい」「わかりました」「お願いします」「画面を出しますね」「次へ」
- 説明: 事実・数字・状況・経緯の共有
- 問い: 会議で答えを出すべき問いを投げかけた
- 提案: 「〜してはどうか」「〜という手もある」と、やり方の候補を出した
- 懸念: 問題やリスクの指摘
- 合意: 会議として結論を出した。「〜にしましょう」「〜は外す」「〜で決まり」。提案や意見の段階は合意ではない
- 作業: 会議の後にやる作業を引き受けた、または頼まれた。担当は文に出た名前（無ければ空文字）。担当の話者は、名前が出ないまま話し手が自分から引き受けたとき（「私がやります」）だけ、その発言の話者（例 相手 A / 自分）を書く。頼まれた側を話し手から推し量って書かない（それ以外は空文字）。期限は文に出たもの（無ければ空文字）

なし以外ではtextに40字以内で中身を要約する。合意では答えている論点のidを選び、無ければ「新しい論点」を選んで論点の文に問いを書く。
議題: 話し中の議題のidを選ぶ。話題が変わったら「新しい議題」を選び、題に20字以内の議題名を書く。
済み: 話が終わって戻らない議題・論点のidを1つ。ほとんどの回は「なし」。

脱線: ルートの表す会議の目的に答えていない議題の性質。新しい議題にも既存の議題にも指定できる。
- 「脱線の確認用の議題」の全議題を見直す。済みや、今回選んだ議題以外も対象。脱線した議題の子孫には付けない。
- 迷うとき、会議の目的がまだ話に出ていないときは付けない。後の発言で目的との関わりが分かったら外す。
- 変更するものだけ脱線の配列に入れる。idは既存の議題idか「新しい議題」、digressionは付けるならtrue、外すならfalse、evidenceは判断の根拠となる新しい発言の行のid。文が「なし」でも解除が必要なら返す。変更がなければ省略する。

名前: 行頭の「相手 A」「相手 B」のラベルに付けられる名前。確かなときだけ配列に入れる。名前がない回は空配列。誤った名前は、名前がないより悪い。
- 根拠にしてよいのは次の2つだけ。basisに種類を書く。
  - 名乗り: そのラベル本人が名乗った発言（「田中です」）。
  - 呼びかけへの応答: 名前での呼びかけ（「田中さん、どうですか」）の直後に、そのラベルが応じた発言。呼びかけの次に話したラベルだけが対象。
- evidenceには、そのラベルが話した名乗りまたは応答の発言の行のid（「r4」。文の番号ではない）を書く。labelには行頭の「相手 X」を書く（「（名前）」の部分は除く）。
- 次のときは入れない: 複数人への呼びかけ、呼ばれた人と別の人が答えたとき、推測、話題に出ただけの名前、仮の名前（「田中?」）、画面に出ている名前。
- 「自分」と、ラベルの無い「相手」には入れない。
- 名前が付いているラベル（「相手 B（田中）」）は、本人が別の名前を名乗ったときだけ付け替える。`;

export type Sentence = { readonly remark: Remark; readonly text: string };
export const splitSentences = (remark: Remark): Sentence[] =>
  remark.text.split(/(?<=[。？！?!])/).map((text) => text.trim()).filter(Boolean).map((text) => ({ remark, text }));

const summary = Schema.NonEmptyString.check(Schema.isMaxLength(40));
const sentenceSchema = (points: readonly string[]) => Schema.Union([
  Schema.Struct({ 種類: Schema.Literal("なし") }),
  Schema.Struct({ 種類: Schema.Literals(["説明", "問い", "提案", "懸念"]), text: summary }),
  Schema.Struct({ 種類: Schema.Literal("合意"), 論点: Schema.Literals([...points, "新しい論点"]), 論点の文: Schema.String.check(Schema.isMaxLength(40)), text: summary }),
  Schema.Struct({ 種類: Schema.Literal("作業"), 担当: Schema.String, 担当の話者: Schema.String, 期限: Schema.String, text: summary }),
]);
export type Classification = {
  readonly 議題: { readonly id: string; readonly 題: string };
  readonly 文: readonly ReturnType<typeof sentenceSchema>["Type"][];
  readonly 済み: string;
  readonly 名前: readonly InferredSpeakerName[];
  readonly 脱線?: readonly { readonly id: string; readonly digression: boolean; readonly evidence: string }[];
  readonly 補足の削除?: readonly string[];
};

export function classificationRequest(map: MeetingMap, recent: DiffInput["recent"], sentences: readonly Sentence[], speakerNames?: DiffInput["speakerNames"]) {
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
  const supplements = map.order.flatMap((id) => {
    const node = map.nodes[id]!;
    if (node.kind !== "補足") return [];
    const parent = map.nodes[node.parent]!;
    return [{ id, kind: node.kind, text: node.text, parent: { id: parent.id, kind: parent.kind, text: parent.text } }];
  });
  const digressionTopics = map.order.flatMap((id) => {
    const n = map.nodes[id]!;
    if (n.kind !== "議題") return [];
    const ancestors: string[] = [];
    for (let p = n.parent; p !== null; p = map.nodes[p]!.parent) ancestors.push(p);
    return [{ id, text: n.text, ancestors, digression: n.digression === true, talkStatus: n.talkStatus ?? "話し中" }];
  });
  // 文を最後に生成させる（Issue #795）。Apple は最後の文の text で崩れると上限まで出し続けるので、その後ろに必須の項目を置かない
  const schema = Schema.Struct({
    議題: Schema.Struct({ id: Schema.Literals([...topics, "新しい議題"]), 題: Schema.String.check(Schema.isMaxLength(20)) }),
    済み: Schema.Literals(["なし", ...closable]),
    名前: Schema.Array(InferredSpeakerName),
    補足の削除: Schema.optionalKey(supplements.length === 0
      ? Schema.Array(Schema.String).check(Schema.isMaxLength(0))
      : Schema.Array(Schema.Literals(supplements.map((node) => node.id)))),
    脱線: Schema.optionalKey(Schema.Array(Schema.Struct({
      id: Schema.Literals([...digressionTopics.map((n) => n.id), "新しい議題"]),
      digression: Schema.Boolean,
      evidence: Schema.Literals([...new Set(sentences.map((s) => s.remark.id))]),
    }))),
    文: Schema.Array(sentenceSchema(points)).check(Schema.isMinLength(sentences.length), Schema.isMaxLength(sentences.length)),
  });
  const prompt = [
    "## 現在のマップ（話し中の部分）", lines.join("\n"), "",
    "## 補足（削除の確認用。親の情報を含む）", JSON.stringify(supplements), "",
    "## 脱線の確認用の議題（済みも含む。ancestorsは親からルートまでのid）", JSON.stringify(digressionTopics), "",
    "## 直前の発言（処理済み・文脈用）", recent.length ? recent.map((r) => remarkLine(r, { name: nameOfSpeaker(r, speakerNames) })).join("\n") : "（なし）", "",
    `## 新しい発言（${sentences.length} 文）`, sentences.map((s, i) => `${i + 1}. ${remarkLine(s.remark, { text: s.text, name: nameOfSpeaker(s.remark, speakerNames) })}`).join("\n"),
  ].join("\n");
  return { prompt, schema, jsonSchema: Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" }).schema };
}

export const probeRequest = () => {
  const text = "接続を確認します。";
  return classificationRequest(emptyMap("接続確認"), [], [{ remark: { id: "probe", track: "相手", start: 0, end: 1, text }, text }]);
};
