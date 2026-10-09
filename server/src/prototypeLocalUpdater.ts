// 試作（issue #487、使い捨て）。Apple Intelligence 向けに、毎回 1 から呼ぶ差分更新。
// 会話を続けず、短い SYSTEM と話し中の部分だけのマップを毎回送る。出力の id は、その呼び出しで使える id だけの列挙型に縛り、
// add の仮 id はサーバーが「新1, 新2 …」と順に振る（モデルは ref を書かない）。
// LOCAL_LLM_SHAPE=stateless で diffUpdater.ts がこちらを使う。宛先は LOCAL_LLM_URL（OpenAI 互換）。
import { appendFileSync } from "node:fs";
import { Effect, Layer, Schema } from "effect";
import { callResponses } from "../bench/chatgpt.ts";
import { children, DiffUpdater, ROOT_ID, type DiffInput, type DiffOutput, type MeetingMap, type Op, type Remark } from "./core/index.ts";

const env = process.env;
const URL_ = env.LOCAL_LLM_URL ?? "";
const MODEL = env.LOCAL_LLM_MODEL ?? "local";
const METRICS = env.LOCAL_LLM_METRICS;
const EXTRA = JSON.parse(env.LOCAL_LLM_EXTRA_BODY ?? "{}");
const TIMEOUT_MS = Number(env.LOCAL_LLM_TIMEOUT_MS ?? 300_000);
const MAX_OPS = 6;

const SYSTEM_V1 = `あなたは会議のマインドマップに、新しい発言の内容を書き足す係です。
マップは root を根とする木です。ノードの種別:
- 議題: 話題のまとまり。話題が変わったら root の下に新しく立てる
- 論点: 会議で答えを出すべき問い
- 案: 論点への答えの候補、またはアイデア
- 決定: 論点に対する会議の合意。「〜にしましょう」「〜で決まり」「〜でいきます」など。親は必ず論点
- TODO: 誰かが後でやると決まった作業。「〜さんが〜する」「〜を確認しておきます」「〜を持ち帰ります」など
- 課題: 問題や懸念
- 要点: 説明・紹介・数字・質問と答えなど、共有された中身

操作:
- add: parent（親の id）・kind・text・evidence（根拠の発言 id）でノードを作る。この応答で add したノードは、順に 新1, 新2 … という id で後の add の parent に使える
- todo: TODO を作る。担当者と期限は発言に出たときだけ書き、出ていなければ空文字にする
- update: 既存ノードの text を書き換える。誤りの修正や、質問に答えが出たときだけ使う
- close: 話が終わって戻らない議題・論点を済みにする

規則:
- text は 40 字以内の要約。発言をそのまま写さない
- 合意は必ず決定にする。答えている論点がマップに無ければ、先に論点を add し、その 新k を parent にして決定を add する
- 作業を引き受けた・割り当てた発言は必ず todo にする
- すでにマップにある内容は書き足さない
- 相づちや進行の段取りだけなら ops を空にする
- 1 回の操作は ${MAX_OPS} 個まで`;

const fmtTime = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const fmtRemark = (r: Remark) => `${r.id} [${fmtTime(r.start)}] ${r.text}`;

// 話し中の部分だけの木。済みのノードは 1 行にして配下を出さない
function renderOpenOutline(map: MeetingMap): { text: string; ids: string[]; closable: string[] } {
  const lines: string[] = [`- root 会議: ${map.nodes[ROOT_ID]!.text}`];
  const ids: string[] = [ROOT_ID];
  const closable: string[] = [];
  const walk = (id: string, depth: number) => {
    for (const c of children(map, id)) {
      const done = !!c.talkStatus;
      lines.push(`${"  ".repeat(depth)}- ${c.id} ${c.kind}: ${c.text}${done ? "（済み）" : ""}`);
      ids.push(c.id);
      if (!done && (c.kind === "議題" || c.kind === "論点")) closable.push(c.id);
      if (!done) walk(c.id, depth + 1);
    }
  };
  walk(ROOT_ID, 1);
  return { text: lines.join("\n"), ids, closable };
}

// この呼び出しで使える id だけを列挙した出力スキーマ（JSON Schema）
function outputSchemaV1(ids: string[], closable: string[], evidence: string[]) {
  const news = Array.from({ length: MAX_OPS }, (_, i) => `新${i + 1}`);
  const str = { type: "string" };
  const ev = { type: "array", items: { type: "string", enum: evidence }, minItems: 1 };
  const obj = (op: string, props: Record<string, unknown>) => ({
    type: "object", additionalProperties: false,
    properties: { op: { type: "string", enum: [op] }, ...props },
    required: ["op", ...Object.keys(props)],
  });
  const variants = [
    obj("add", { kind: { type: "string", enum: ["議題", "論点", "案", "決定", "課題", "要点"] }, parent: { type: "string", enum: [...ids, ...news] }, text: str, evidence: ev }),
    obj("todo", { parent: { type: "string", enum: [...ids, ...news] }, text: str, assignee: str, due: str, evidence: ev }),
    ...(ids.length > 1 ? [obj("update", { node: { type: "string", enum: ids.filter((i) => i !== ROOT_ID) }, text: str, evidence: ev })] : []),
    ...(closable.length ? [obj("close", { node: { type: "string", enum: closable } })] : []),
  ];
  return { type: "object", additionalProperties: false, properties: { ops: { type: "array", items: { anyOf: variants }, maxItems: MAX_OPS } }, required: ["ops"] };
}

const blank = (s: string | undefined) => !s || /^(なし|無し|未定|不明|-|―|N\/A)$/i.test(s.trim());

// モデルの出力を core の Op に写す。add / todo には出てきた順に 新k の ref を振る
function toOpsV1(raw: any[]): Op[] {
  let k = 0;
  return raw.flatMap((o): Op[] => {
    switch (o.op) {
      case "add": return [{ op: "add", ref: `新${++k}`, parent: o.parent, kind: o.kind, text: o.text, evidence: o.evidence }];
      case "todo": return [{ op: "add", ref: `新${++k}`, parent: o.parent, kind: "TODO", text: o.text, evidence: o.evidence,
        ...(blank(o.assignee) ? {} : { assignee: o.assignee }), ...(blank(o.due) ? {} : { due: o.due }) }];
      case "update": return [{ op: "update", node: o.node, text: o.text, evidence: o.evidence }];
      case "close": return [{ op: "close", node: o.node }];
      default: return [];
    }
  });
}


// ---- v2: 新しい発言 1 つごとに種類を選ばせ、ノードの種別と置き場所はサーバーが決める ----
const ACTS = ["相づち・進行", "説明", "問い", "提案", "懸念", "合意", "作業の引き受け"] as const;
const ACT_KIND = { 説明: "要点", 問い: "論点", 提案: "案", 懸念: "課題" } as const;

const SYSTEM_V2 = `あなたは会議のマインドマップに、新しい発言の内容を書き足す係です。
マップは root を根とする木で、話題ごとの議題の下に、発言から作ったノードがぶら下がります。

毎回、次の 2 つを返します。
1. 議題: 新しい発言がどの議題の話か。マップの話し中の議題の id を選ぶ。話題が変わったときだけ「新しい議題」を選び、題に 20 字以内の議題名を書く
2. 発言: 新しい発言 1 つごとに、種類を 1 つ選ぶ

種類:
- 相づち・進行: 「はい」「なるほど」、会議の始め・終わり・順番・画面共有の段取り。中身が無い
- 説明: 事実・数字・状況・経緯の共有。迷ったらこれ
- 問い: 会議で答えを出すべき問いを投げかけた
- 提案: 「〜してはどうか」「〜という手もある」と、やり方の候補を出した
- 懸念: 問題やリスクを指摘した
- 合意: 会議として結論を出した。「〜にしましょう」「〜で決まり」「〜でいきます」「それでお願いします」。提案や意見の段階は合意ではない
- 作業の引き受け: 特定の人が、会議の後にやる作業を引き受けた、または頼まれた。「〜を出します」「〜を調べておきます」「〜さん、〜をお願いします」

相づち・進行 以外では、text に 40 字以内で中身を要約する（発言をそのまま写さない）。
- 合意: 論点に、答えている問いをマップの論点の id から選ぶ。無ければ「新しい論点」を選び、論点の文に問いを書く
- 作業の引き受け: 担当に発言に出た人の名前を、期限に発言に出た期限を書く。出ていなければ空文字
- 説明・問い・提案・懸念: 親に、補足する先のノードを選ぶ。特に無ければ「議題の直下」。同じ応答で前の発言から作ったノードは「新r12」のように指せる
- 済み: 話が終わって戻らない議題・論点があれば、その id を 1 つ選ぶ。ほとんどの回は「なし」`;

function outlineV2(map: MeetingMap) {
  const o = renderOpenOutline(map);
  const open = (kind: string) => o.ids.filter((id) => id !== ROOT_ID && map.nodes[id]!.kind === kind && !map.nodes[id]!.talkStatus);
  const parents = o.ids.filter((id) => id !== ROOT_ID && !map.nodes[id]!.talkStatus && !["決定", "TODO"].includes(map.nodes[id]!.kind));
  return { ...o, topics: open("議題"), points: open("論点"), parents };
}

function outputSchemaV2(o: ReturnType<typeof outlineV2>, fresh: string[]) {
  const str = { type: "string" };
  const obj = (props: Record<string, unknown>) => ({ type: "object", additionalProperties: false, properties: props, required: Object.keys(props) });
  const remark = { type: "string", enum: fresh };
  const items = [
    obj({ 発言: remark, 種類: { type: "string", enum: ["相づち・進行"] } }),
    obj({ 発言: remark, 種類: { type: "string", enum: ["説明", "問い", "提案", "懸念"] }, 親: { type: "string", enum: ["議題の直下", ...o.parents, ...fresh.map((r) => `新${r}`)] }, text: str }),
    obj({ 発言: remark, 種類: { type: "string", enum: ["合意"] }, 論点: { type: "string", enum: [...o.points, "新しい論点"] }, 論点の文: str, text: str }),
    obj({ 発言: remark, 種類: { type: "string", enum: ["作業の引き受け"] }, text: str, 担当: str, 期限: str }),
  ];
  return obj({
    議題: obj({ id: { type: "string", enum: [...o.topics, "新しい議題"] }, 題: str }),
    発言: { type: "array", items: { anyOf: items }, minItems: fresh.length, maxItems: fresh.length },
    済み: { type: "string", enum: ["なし", ...o.closable] },
  });
}

function toOpsV2(raw: any, map: MeetingMap, fresh: string[], multi = false): Op[] {
  const ops: Op[] = [];
  const first = fresh[0]!;
  const valid = (id: string) => !!map.nodes[id] || ops.some((o) => o.op === "add" && o.ref === id);
  let topic: string = raw.議題?.id;
  if (topic === "新しい議題" || !valid(topic)) {
    const ev = (raw.発言 ?? []).find((x: any) => x.種類 !== "相づち・進行")?.発言;
    if (topic === "新しい議題" && ev && raw.議題.題) { ops.push({ op: "add", ref: "新議題", parent: ROOT_ID, kind: "議題", text: raw.議題.題, evidence: [ev] }); topic = "新議題"; }
    else topic = ROOT_ID;
  }
  let seqNo = 0;
  for (const x of raw.発言 ?? []) {
    if (x.種類 !== "相づち・進行" && !x.text) continue;
    const r = x.発言 ?? first;
    const ref = multi ? `新${r}-${++seqNo}` : `新${r}`;
    if (ops.some((o) => o.op === "add" && o.ref === ref)) continue; // 同じ発言を 2 回選んだら最初だけ
    switch (x.種類) {
      case "説明": case "問い": case "提案": case "懸念": {
        const parent = x.親 === "議題の直下" || !valid(x.親) ? topic : x.親;
        ops.push({ op: "add", ref, parent, kind: ACT_KIND[x.種類 as keyof typeof ACT_KIND], text: x.text, evidence: [r] });
        break;
      }
      case "合意": {
        let point: string = x.論点;
        if (point === "新しい論点" || !valid(point)) {
          point = `${ref}の論点`;
          ops.push({ op: "add", ref: point, parent: topic, kind: "論点", text: x.論点の文 || x.text, evidence: [r] });
        }
        ops.push({ op: "add", ref, parent: point, kind: "決定", text: x.text, evidence: [r] });
        break;
      }
      case "作業の引き受け":
        ops.push({ op: "add", ref, parent: topic, kind: "TODO", text: x.text, evidence: [r],
          ...(blank(x.担当) ? {} : { assignee: x.担当 }), ...(blank(x.期限) ? {} : { due: x.期限 }) });
        break;
    }
  }
  if (raw.済み && map.nodes[raw.済み] && raw.済み !== topic) ops.push({ op: "close", node: raw.済み });
  return ops;
}

// ---- v3: 種類ごとの欄に分け、作業 → 合意 → 中身 の順に拾わせる。1 つの発言から複数を拾える ----
const SYSTEM_V3 = `あなたは会議のマインドマップに、新しい発言の内容を書き足す係です。
マップは root を根とする木で、話題ごとの議題の下に、発言から拾ったノードがぶら下がります。
1 つの発言の中に、説明・合意・作業の引き受け・話題の切り替えが混ざっていることがよくあります。発言を文ごとに読み、次の順に拾ってください。

1. 議題: 新しい発言の主な話題が、マップの話し中の議題のどれか。その id を選ぶ。話題が変わったら「新しい議題」を選び、題に 20 字以内の議題名を書く（「〜の話に行きましょう」「次は〜」は話題の切り替え）
2. 作業の引き受け: 特定の人が会議の後にやる作業を引き受けた・頼まれたもの。「〜を出します」「〜を調べておきます」「〜を持ってきます」「話しておきます」「〜を取ります」「〜さん、〜をお願いします」。担当に名前、期限に「来週まで」などを書き、出ていなければ空文字
3. 合意: 会議として結論を出したもの。「〜にしましょう」「〜にしよう」「〜で決まり」「〜でいきます」「〜は外す」「〜しておいてください」（やり方の指示）。論点には答えている問いの id を選び、無ければ「新しい論点」を選んで論点の文に問いを書く
4. 中身: 残りのうち残す価値のあるもの。種類は 説明（事実・数字・状況）・問い（答えを出すべき問い）・提案（やり方の候補）・懸念（問題やリスク）。親は補足する先のノード、特に無ければ「議題の直下」
5. 済み: 話が終わって戻らない議題・論点の id を 1 つ。ほとんどの回は「なし」

- 相づち・段取り（「はい」「お願いします」「画面を出します」）は拾わない
- text は 40 字以内の要約。発言をそのまま写さない
- 無い欄は空の配列にする`;

function outputSchemaV3(o: ReturnType<typeof outlineV2>, fresh: string[]) {
  const str = { type: "string" };
  const obj = (props: Record<string, unknown>) => ({ type: "object", additionalProperties: false, properties: props, required: Object.keys(props) });
  const remark = { type: "string", enum: fresh };
  const arr = (item: object, max: number) => ({ type: "array", items: item, maxItems: max });
  return obj({
    議題: obj({ id: { type: "string", enum: [...o.topics, "新しい議題"] }, 題: str }),
    作業の引き受け: arr(obj({ 発言: remark, 担当: str, 期限: str, text: str }), 3),
    合意: arr(obj({ 発言: remark, 論点: { type: "string", enum: [...o.points, "新しい論点"] }, 論点の文: str, text: str }), 3),
    中身: arr(obj({ 発言: remark, 種類: { type: "string", enum: ["説明", "問い", "提案", "懸念"] }, 親: { type: "string", enum: ["議題の直下", ...o.parents] }, text: str }), 4),
    済み: { type: "string", enum: ["なし", ...o.closable] },
  });
}

// v2 の写し方に乗せる（発言の列に並べ直す）。同じ発言から複数を拾えるよう、ref に通し番号を付ける
function toOpsV3(raw: any, map: MeetingMap, fresh: string[]): Op[] {
  const items = [
    ...(raw.作業の引き受け ?? []).map((x: any) => ({ ...x, 種類: "作業の引き受け" })),
    ...(raw.合意 ?? []).map((x: any) => ({ ...x, 種類: "合意" })),
    ...(raw.中身 ?? []),
  ];
  return toOpsV2({ 議題: raw.議題, 発言: items, 済み: raw.済み }, map, fresh, true);
}

// ---- v4: v3 の欄の前に「ある/ない」を答えさせ、マップは議題と論点の行だけを見せる ----
const SYSTEM_V4 = SYSTEM_V3
  .replace("2. 作業の引き受け:", "2. 作業の引き受け（無い回が多い。あるときだけ「はい」）:")
  .replace("3. 合意:", "3. 合意（無い回が多い。あるときだけ「はい」）:")
  .replace("マップは root を根とする木で、話題ごとの議題の下に、発言から拾ったノードがぶら下がります。", "マップは root を根とする木で、話題ごとの議題の下に、発言から拾ったノードがぶら下がります。現在のマップには議題と論点だけを見せます。");

function outlineV4(map: MeetingMap) {
  const lines: string[] = [`- root 会議: ${map.nodes[ROOT_ID]!.text}`];
  const topics: string[] = [], points: string[] = [];
  const walk = (id: string, depth: number) => {
    for (const c of children(map, id)) {
      if (c.kind !== "議題" && c.kind !== "論点") continue;
      const done = !!c.talkStatus;
      const decided = c.kind === "論点" && children(map, c.id).some((x) => x.kind === "決定");
      lines.push(`${"  ".repeat(depth)}- ${c.id} ${c.kind}: ${c.text}${done ? "（済み）" : decided ? "（決定済み）" : ""}`);
      if (done) continue;
      (c.kind === "議題" ? topics : points).push(c.id);
      walk(c.id, depth + 1);
    }
  };
  walk(ROOT_ID, 1);
  return { text: lines.join("\n"), ids: [ROOT_ID, ...topics, ...points], closable: [...topics, ...points], topics, points, parents: [...topics, ...points] };
}

function outputSchemaV4(o: ReturnType<typeof outlineV4>, fresh: string[]) {
  const str = { type: "string" };
  const obj = (props: Record<string, unknown>) => ({ type: "object", additionalProperties: false, properties: props, required: Object.keys(props) });
  const remark = { type: "string", enum: fresh };
  const gated = (item: object, max: number) => ({ anyOf: [
    obj({ ある: { type: "string", enum: ["いいえ"] } }),
    obj({ ある: { type: "string", enum: ["はい"] }, 項目: { type: "array", items: item, minItems: 1, maxItems: max } }),
  ] });
  return obj({
    議題: obj({ id: { type: "string", enum: [...o.topics, "新しい議題"] }, 題: str }),
    作業の引き受け: gated(obj({ 発言: remark, 担当: str, 期限: str, text: str }), 2),
    合意: gated(obj({ 発言: remark, 論点: { type: "string", enum: [...o.points, "新しい論点"] }, 論点の文: str, text: str }), 2),
    中身: gated(obj({ 発言: remark, 種類: { type: "string", enum: ["説明", "問い", "提案", "懸念"] }, 親: { type: "string", enum: ["議題の直下", ...o.parents] }, text: str }), 3),
    済み: { type: "string", enum: ["なし", ...o.closable] },
  });
}

const ungate = (g: any) => (g?.ある === "はい" ? g.項目 ?? [] : []);
function toOpsV4(raw: any, map: MeetingMap, fresh: string[]): Op[] {
  return toOpsV3({ 議題: raw.議題, 作業の引き受け: ungate(raw.作業の引き受け), 合意: ungate(raw.合意), 中身: ungate(raw.中身), 済み: raw.済み }, map, fresh);
}

// ---- v5: サーバーが新しい発言を文に切り、文ごとに種類を 1 つ選ばせる。配列の位置で文と対応させる ----
const SYSTEM_V5 = `あなたは会議のマインドマップに、新しい発言の内容を書き足す係です。
新しい発言は文に切って、番号付きで並べてあります。文ごとに種類を 1 つ選び、並べた順に返してください。
現在のマップには議題と論点だけを見せます。

種類:
- なし: 相づち・返事・段取り。「はい」「わかりました」「お願いします」「画面を出しますね」「次へ」。ほとんどの文はこれか説明
- 説明: 事実・数字・状況・経緯の共有
- 問い: 会議で答えを出すべき問いを投げかけた
- 提案: 「〜してはどうか」「〜という手もある」と、やり方の候補を出した
- 懸念: 問題やリスクの指摘
- 合意: 会議として結論を出した文。「〜にしよう」「〜にしましょう」「〜は外す」「〜しておいてください」「〜で決まり」。提案や意見の段階は合意ではない
- 作業: 話し手が会議の後にやる作業を引き受けた文。「〜を出します」「〜を持ってきます」「話しておきます」「〜を数えてきます」「〜を取ります」「〜に入れておきます」。担当は話し手か、頼んだ相手の名前（分からなければ空文字）、期限は文に出たもの（無ければ空文字）

なし 以外では text に 40 字以内で中身を要約する。合意では、答えている論点の id を選び、無ければ「新しい論点」を選んで論点の文に問いを書く。
議題: 新しい発言の主な話題が、マップの話し中の議題のどれか。話題が変わったら「新しい議題」を選び、題に 20 字以内の議題名を書く。
済み: 話が終わって戻らない議題・論点の id を 1 つ。ほとんどの回は「なし」`;

const splitSentences = (fresh: readonly Remark[]) =>
  fresh.flatMap((r) => r.text.split(/(?<=[。？！?!])/).map((t) => t.trim()).filter(Boolean).map((t, i) => ({ id: `${r.id}-${i + 1}`, remark: r.id, text: t })));

function outputSchemaV5(o: ReturnType<typeof outlineV4>, n: number) {
  const str = { type: "string" };
  const obj = (props: Record<string, unknown>) => ({ type: "object", additionalProperties: false, properties: props, required: Object.keys(props) });
  const kind = (...k: string[]) => ({ type: "string", enum: k });
  return obj({
    議題: obj({ id: { type: "string", enum: [...o.topics, "新しい議題"] }, 題: str }),
    文: { type: "array", minItems: n, maxItems: n, items: { anyOf: [
      obj({ 種類: kind("なし") }),
      obj({ 種類: kind("説明", "問い", "提案", "懸念"), text: str }),
      obj({ 種類: kind("合意"), 論点: { type: "string", enum: [...o.points, "新しい論点"] }, 論点の文: str, text: str }),
      obj({ 種類: kind("作業"), 担当: str, 期限: str, text: str }),
    ] } },
    済み: { type: "string", enum: ["なし", ...o.closable] },
  });
}

function toOpsV5(raw: any, map: MeetingMap, sentences: ReturnType<typeof splitSentences>): Op[] {
  const items = (raw.文 ?? []).slice(0, sentences.length).flatMap((x: any, i: number) => {
    const 発言 = sentences[i]!.remark;
    if (x.種類 === "なし") return [];
    if (x.種類 === "作業") return [{ ...x, 発言, 種類: "作業の引き受け" }];
    return [{ ...x, 発言, 親: "議題の直下" }];
  });
  return toOpsV2({ 議題: raw.議題, 発言: items, 済み: raw.済み }, map, [...new Set(sentences.map((x) => x.remark))], true);
}

const VARIANT = env.LOCAL_LLM_VARIANT ?? "v2";

const record = (row: object) => { if (METRICS) appendFileSync(METRICS, JSON.stringify(row) + "\n"); };

class LocalLlmFailed extends Schema.TaggedError<LocalLlmFailed>()("LocalLlmFailed", { message: Schema.String }) {}

export const StatelessDiffUpdater = {
  layer: Layer.sync(DiffUpdater, () => {
    let seq = 0;
    const update = ({ map, recent, fresh }: DiffInput) =>
      Effect.tryPromise({
        try: async (): Promise<DiffOutput> => {
          const outline = VARIANT === "v4" || VARIANT === "v5" ? outlineV4(map) : outlineV2(map);
          const sentences = splitSentences(fresh);
          const freshIds = fresh.map((r) => r.id);
          const prompt = [
            "## 現在のマップ（話し中の部分）", outline.text, "",
            "## 直前の発言（処理済み・文脈用）", recent.length ? recent.map(fmtRemark).join("\n") : "（なし）", "",
            ...(VARIANT === "v5"
              ? [`## 新しい発言（${sentences.length} 文）`, sentences.map((x, i) => `${i + 1}. [${x.remark}] ${x.text}`).join("\n")]
              : ["## 新しい発言", fresh.map(fmtRemark).join("\n")]),
          ].join("\n");
          const body = {
            model: MODEL, temperature: 0.2,
            messages: [{ role: "system", content: VARIANT === "v1" ? SYSTEM_V1 : VARIANT === "v3" ? SYSTEM_V3 : VARIANT === "v4" ? SYSTEM_V4 : VARIANT === "v5" ? SYSTEM_V5 : SYSTEM_V2 }, { role: "user", content: prompt }],
            response_format: { type: "json_schema", json_schema: { name: "diff", strict: true, schema: VARIANT === "v1" ? outputSchemaV1(outline.ids, outline.closable, freshIds) : VARIANT === "v3" ? outputSchemaV3(outline, freshIds) : VARIANT === "v4" ? outputSchemaV4(outline, freshIds) : VARIANT === "v5" ? outputSchemaV5(outline, sentences.length) : outputSchemaV2(outline, freshIds) } },
            ...EXTRA,
          };
          const t0 = performance.now();
          const id = ++seq;
          if (env.LOCAL_LLM_DUMP) appendFileSync(`${env.LOCAL_LLM_DUMP}/${id}.json`, JSON.stringify(body));
          let json: any, ms: number, text: string, extra: object = {};
          if (env.LOCAL_LLM_ROUTE === "chatgpt") {
            // ChatGPT のプラン利用（issue #635）。system は instructions に、response_format は text.format に移す
            const r = await callResponses({
              model: MODEL, instructions: body.messages[0]!.content, input: [body.messages[1]],
              text: { format: { type: "json_schema", name: "diff", strict: true, schema: body.response_format.json_schema.schema } },
              ...EXTRA,
            }, TIMEOUT_MS);
            ms = r.ms;
            extra = { firstByteMs: r.firstByteMs, headers: r.headers, requestId: r.requestId };
            if (r.error !== undefined) { record({ id, ms, error: "http", status: r.status, detail: r.error, ...extra }); throw new Error(`HTTP ${r.status}`); }
            json = { usage: r.usage };
            text = r.text ?? "";
          } else {
          const res = await fetch(`${URL_}/chat/completions`, {
            method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
          json = await res.json();
          ms = Math.round(performance.now() - t0);
          if (!res.ok) { record({ id, ms, error: "http", status: res.status, detail: JSON.stringify(json).slice(0, 300) }); throw new Error(`HTTP ${res.status}`); }
          text = json.choices?.[0]?.message?.content ?? "";
          }
          let parsed: any;
          try { parsed = JSON.parse(text); } catch { record({ id, ms, error: "json", usage: json.usage }); throw new Error("JSON が読めない"); }
          const ops = VARIANT === "v1" ? toOpsV1(parsed.ops ?? []) : VARIANT === "v3" ? toOpsV3(parsed, map, freshIds) : VARIANT === "v4" ? toOpsV4(parsed, map, freshIds) : VARIANT === "v5" ? toOpsV5(parsed, map, sentences) : toOpsV2(parsed, map, freshIds);
          record({ id, ms, ops: ops.length, kinds: VARIANT === "v1" ? (parsed.ops ?? []).map((o: any) => o.op === "add" ? o.kind : o.op) : [parsed.議題?.id === "新しい議題" ? "新議題" : "同議題", ...(parsed.発言 ?? []).map((x: any) => x.種類), ...(parsed.文 ?? []).map((x: any) => x.種類), ...(VARIANT === "v4" ? [...ungate(parsed.作業の引き受け).map(() => "作業"), ...ungate(parsed.合意).map(() => "合意"), ...ungate(parsed.中身).map((x: any) => x.種類)] : [...(parsed.作業の引き受け ?? []).map(() => "作業"), ...(parsed.合意 ?? []).map(() => "合意"), ...(parsed.中身 ?? []).map((x: any) => x.種類)]), ...(parsed.済み && parsed.済み !== "なし" ? ["済み"] : [])], usage: json.usage, timings: json.timings, ...extra });
          return { ops };
        },
        catch: (e) => new LocalLlmFailed({ message: e instanceof Error ? e.message : String(e) }),
      });
    return DiffUpdater.of({ update });
  }),
};
