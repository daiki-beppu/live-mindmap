// 回帰評価: 再生したマップの指標と、正解の決定・TODO に対する再現率。Node に依存しない（ADR 0003）。
import { Predicate, Schema } from "effect";
import type { ExportNode, JsonExport } from "./export.ts";
import { KINDS, type Kind } from "./map.ts";

// 比べる前に、本文とキーワードの両方にかける。全角・半角の違いと空白を吸収する（漢数字と算用数字は読み替えない）
const normalize = (s: string) => s.normalize("NFKC").replace(/\s/g, "");

// 空文字は、どの本文にも含まれて条件が消えるので受け付けない
const isWord = (v: unknown): v is string => typeof v === "string" && normalize(v) !== "";

// 正解は人が書く。from / to は会議の中の秒（Remark.start / end と同じ単位）。text は人が読むためで、照合には使わない。
// keywords は 1 件以上で、ノードの本文（text）に含まれるべき語。要素が文字列ならその語、文字列の配列なら言い換えの候補（どれか 1 つ）。要素すべてが満たされて当たる。
// 検査の失敗の文面はここが正本。cli.ts が decode の失敗をそのまま日本語の 1 行に使うので、既定の英語の文面に落とさない
// （cli.ts は場所だけを path から付ける）。filter は文字列を返し、型と欠落は message / messageMissingKey で同じ文面にする
const TRUTH_OBJECT_RULE = "正解はオブジェクトで書く";
// 主語を持たないのは、この文面が出る位置が種別のキー（決定・TODO）だけで、必ず cli.ts の「<種別>」の後に続くため
const KIND_LIST_RULE = "は配列で書く";
const TIME_RULE = "from / to は秒の数値で書く";
const TIME_ORDER_RULE = "from が to より大きい";
const KEYWORDS_RULE = "keywords は 1 件以上の配列で書く（要素は文字列か、文字列の配列）";
// annotate は検査（check）があるとその検査に付くので、型の不一致（InvalidType）の文面にするには check より前に置く
const atLeastOne = Schema.makeFilter<{ readonly length: number }>((v) => v.length >= 1 || KEYWORDS_RULE);
const Word = Schema.String.annotate({ message: KEYWORDS_RULE }).check(Schema.makeFilter((s) => isWord(s) || KEYWORDS_RULE));
export const Keyword = Schema.Union([
  Word,
  Schema.mutable(Schema.Array(Word)).annotate({ message: KEYWORDS_RULE }).check(atLeastOne),
]).annotate({ message: KEYWORDS_RULE });
export type Keyword = typeof Keyword["Type"];

const seconds = Schema.Number.annotate({ message: TIME_RULE }).annotateKey({ messageMissingKey: TIME_RULE });

// 時刻の前後だけを、下の Struct より前に見る段。struct の check は全プロパティが通ったときにだけ走るので
// （effect 4.0.1 の interpreter）、ここを struct の check にすると同じ項目の keywords の失敗が先に出てしまい、
// parseTruth の順（from / to の型 → from <= to → keywords）と理由が入れ替わる。
// from / to が数でない間はここを通し、型の文面は下の Struct（seconds）に任せる
const itemTimeOrder = Schema.Unknown.check(
  Schema.makeFilter((item) =>
    !Predicate.isObject(item) || !Predicate.isNumber(item.from) || !Predicate.isNumber(item.to)
    || item.from <= item.to || TIME_ORDER_RULE
  ),
);

export const TruthItem = itemTimeOrder.pipe(
  Schema.decodeTo(
    Schema.Struct({
      text: Schema.optionalKey(Schema.String), // 省略できる（parseTruth も省略を空文字で受ける）
      from: seconds,
      to: seconds,
      keywords: Schema.mutable(Schema.Array(Keyword)).annotate({ message: KEYWORDS_RULE }).check(atLeastOne).annotateKey({
        messageMissingKey: KEYWORDS_RULE,
      }),
    })
      // 1 件がオブジェクトでなければ from / to が読めない。parseTruth もその場合は from / to の文面で止める
      .annotate({ message: TIME_RULE }),
  ),
);
export type TruthItem = typeof TruthItem["Type"];

export const TRUTH_KINDS = ["決定", "TODO"] as const satisfies readonly Kind[];
export type TruthKind = (typeof TRUTH_KINDS)[number];

// 正解ファイルの形。段 4（bench は段 5）でここから読み込みを検証する。
export const Truth = Schema.Record(
  Schema.Literals(TRUTH_KINDS),
  Schema.mutableKey(Schema.mutable(Schema.Array(TruthItem)).annotate({ message: KIND_LIST_RULE })).annotateKey({
    messageMissingKey: KIND_LIST_RULE,
  }),
).annotate({ message: TRUTH_OBJECT_RULE });
export type Truth = typeof Truth["Type"];

export type Metrics = { nodes: number; depth: number; byKind: Record<Kind, number> };
export type Recall = { hit: number; total: number };
export type Run = { name: string; title: string; exp: JsonExport };

function parseKeywords(raw: unknown, at: string): Keyword[] {
  const fail = () => new Error(`${at}: keywords は 1 件以上の配列で書く（要素は文字列か、文字列の配列）`);
  if (!Array.isArray(raw) || raw.length === 0) throw fail();
  return raw.map((k: unknown) => {
    if (isWord(k)) return k;
    if (Array.isArray(k) && k.length > 0 && k.every(isWord)) return [...k] as string[];
    throw fail();
  });
}

// JSON.parse した正解を検証して Truth にする。形が違えば Error（呼び出し側がファイルのパスを添える）。
// 正解の形（{ "決定": [{ text?, from, to, keywords }], "TODO": [...] }、from / to は会議の中の秒、
// keywords は 1 件以上で要素は文字列か言い換えの文字列の配列）は、上の TruthItem・Keyword が正本。
// cli eval は Truth の Schema で読む（段 4）。この手書きの検証は bench 用に残す（bench の移行は段 5）
export function parseTruth(raw: unknown): Truth {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("正解はオブジェクトで書く");
  const obj = raw as Record<string, unknown>;
  const truth = {} as Truth;
  for (const kind of TRUTH_KINDS) {
    const list = obj[kind];
    if (!Array.isArray(list)) throw new Error(`「${kind}」は配列で書く`);
    truth[kind] = list.map((item, i) => {
      const { text, from, to, keywords } = (item ?? {}) as Record<string, unknown>;
      const at = `「${kind}」の ${i + 1} 件目`;
      if (typeof from !== "number" || typeof to !== "number") throw new Error(`${at}: from / to は秒の数値で書く`);
      if (from > to) throw new Error(`${at}: from が to より大きい`);
      return { text: typeof text === "string" ? text : "", from, to, keywords: parseKeywords(keywords, at) };
    });
  }
  return truth;
}

const walk = (node: ExportNode, depth: number, visit: (n: ExportNode, depth: number) => void) => {
  for (const c of node.children) {
    visit(c, depth + 1);
    walk(c, depth + 1, visit);
  }
};

// ノード数はルートを除く。深さはルートの子を 1 とし、ノードが無ければ 0
export function measure(exp: JsonExport): Metrics {
  const byKind = Object.fromEntries(KINDS.map((k) => [k, 0])) as Record<Kind, number>;
  let nodes = 0;
  let depth = 0;
  walk(exp.root, 0, (n, d) => {
    nodes++;
    depth = Math.max(depth, d);
    if (n.kind !== "会議") byKind[n.kind]++;
  });
  return { nodes, depth, byKind };
}

// ノードが正解に当たる条件（すべて満たす）: 種別が同じ（呼び出し側で絞る）、根拠の発言のどれか 1 つが区間と重なる（端が接するのも重なり）、
// keywords の要素すべてが本文に含まれる（配列の要素はどれか 1 つ）。本文もキーワードも NFKC で正規化し空白を除いて比べる
const matches = (node: ExportNode, { from, to, keywords }: TruthItem) => {
  const body = normalize(node.text);
  return (
    node.evidence.some((r) => r.start <= to && r.end >= from) &&
    keywords.every((k) => (Array.isArray(k) ? k : [k]).some((alt) => body.includes(normalize(alt))))
  );
};

// 当たる件数が最大になる割り当ての件数（二部グラフの最大マッチング、増加路法）。candidates[i] は正解 i に当たるノードの番号
function maxMatching(candidates: number[][], nodeCount: number): number {
  const owner: number[] = Array.from({ length: nodeCount }, () => -1);
  const assign = (t: number, visited: boolean[]): boolean =>
    (candidates[t] ?? []).some((n) => {
      if (visited[n]) return false;
      visited[n] = true;
      const current = owner[n] ?? -1;
      if (current !== -1 && !assign(current, visited)) return false;
      owner[n] = t;
      return true;
    });
  return candidates.filter((_, t) => assign(t, Array.from({ length: nodeCount }, () => false))).length;
}

// 同じ種別のノードと正解を 1 対 1 で対応させ、当たる件数が最大になる割り当ての件数を再現できた数とする（当たる条件は matches）
export function recall(exp: JsonExport, truth: Truth): Record<TruthKind, Recall> {
  const nodes: ExportNode[] = [];
  walk(exp.root, 0, (n) => nodes.push(n));
  return Object.fromEntries(
    TRUTH_KINDS.map((kind) => {
      const sameKind = nodes.filter((n) => n.kind === kind);
      const candidates = truth[kind].map((item) => sameKind.flatMap((n, i) => (matches(n, item) ? [i] : [])));
      return [kind, { hit: maxMatching(candidates, sameKind.length), total: truth[kind].length }];
    }),
  ) as Record<TruthKind, Recall>;
}

const RECALL_HEADERS: Record<TruthKind, string> = { 決定: "決定の再現率", TODO: "TODO の再現率" };

const formatRecall = ({ hit, total }: Recall) => (total === 0 ? "0/0" : `${hit}/${total} (${Math.round((hit / total) * 100)}%)`);

// 表のセルに入れる文字列。区切りの `|` と、その直前の `\` をエスケープし、改行は空白 1 つにして 1 行に保つ
const escapeCell = (cell: string) => cell.replace(/[\\|]/g, "\\$&").replace(/\r\n|\r|\n/g, " ");

// 1 ラン 1 行の Markdown の表（cli eval の標準出力）。truth があるときだけ、決定・TODO の再現率の列を足す。
// 再現率の分子は recall が数える「当たった件数」で、当たる条件は matches、1 対 1 の割り当ては maxMatching が持つ
export function formatTable(runs: Run[], truth?: Truth): string {
  const header = ["ラン", "会議", "ノード", "深さ", ...KINDS, ...(truth ? TRUTH_KINDS.map((k) => RECALL_HEADERS[k]) : [])];
  const rows = runs.map(({ name, title, exp }) => {
    const m = measure(exp);
    const recalls = truth ? TRUTH_KINDS.map((k) => formatRecall(recall(exp, truth)[k])) : [];
    return [name, title, m.nodes, m.depth, ...KINDS.map((k) => m.byKind[k]), ...recalls].map(String);
  });
  const line = (cells: string[]) => `| ${cells.map(escapeCell).join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join("\n") + "\n";
}
