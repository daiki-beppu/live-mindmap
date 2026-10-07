// 回帰評価: 再生したマップの指標と、正解の決定・TODO に対する再現率。Node に依存しない（ADR 0003）。
import { Predicate, Schema } from "effect";
import type { ExportNode, JsonExport } from "./export.ts";
import { logMetrics } from "./logMetrics.ts";
import { KINDS, type Kind } from "./map.ts";
import type { LogEvent } from "./session.ts";

// 比べる前に、本文とキーワードの両方にかける。全角・半角の違いと空白を吸収する（漢数字と算用数字は読み替えない）
const normalize = (s: string) => s.normalize("NFKC").replace(/\s/g, "");

// 空文字は、どの本文にも含まれて条件が消えるので受け付けない
const isWord = (v: unknown): v is string => typeof v === "string" && normalize(v) !== "";

// 正解は人が書く。from / to は会議の中の秒（Remark.start / end と同じ単位）。text は人が読むためで、照合には使わない。
// keywords は 1 件以上で、ノードの本文（text）に含まれるべき語。要素が文字列ならその語、文字列の配列なら言い換えの候補（どれか 1 つ）。要素すべてが満たされて当たる。
// 検査の失敗の文面はここが正本。cli.ts が decode の失敗をそのまま日本語の 1 行に使うので、既定の英語の文面に落とさない
// （cli.ts は場所だけを path から付ける）。filter は文字列を返し、型と欠落は message / messageMissingKey で同じ文面にする
const TRUTH_OBJECT_RULE = "正解はオブジェクトで書く";
// 主語を持たないのは、この文面が出る位置が種別のキー（決定・TODO、指す発言・話だけ・出てはいけない）だけで、必ず cli.ts の「<種別>」の後に続くため
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

// 照合に使う項目の部分。決定・TODO の正解と、共有画面の正解の指す発言・話だけが共有する
const keywordsField = Schema.mutable(Schema.Array(Keyword)).annotate({ message: KEYWORDS_RULE }).check(atLeastOne).annotateKey({
  messageMissingKey: KEYWORDS_RULE,
});
const matchFields = {
  text: Schema.optionalKey(Schema.String), // 省略できる（parseTruth も省略を空文字で受ける）
  from: seconds,
  to: seconds,
  keywords: keywordsField,
};

// 1 件がオブジェクトでなければ from / to が読めない。parseTruth もその場合は from / to の文面で止める
export const TruthItem = itemTimeOrder.pipe(
  Schema.decodeTo(Schema.Struct(matchFields).annotate({ message: TIME_RULE })),
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

// 共有画面の正解（--screen-truth）。指す発言・話だけは TruthItem の照合の部分に、人が読むための項目と memory を足す
// （すべて省略できる。memory は省略すると false）。出てはいけないは時刻を持たず、keywords のどれかを含むノードがあれば漏れ
export const ScreenTruthItem = itemTimeOrder.pipe(
  Schema.decodeTo(
    Schema.Struct({
      ...matchFields,
      speaker: Schema.optionalKey(Schema.String),
      remark: Schema.optionalKey(Schema.String),
      shown: Schema.optionalKey(Schema.String),
      slide: Schema.optionalKey(Schema.String),
      memory: Schema.optionalKey(Schema.Boolean),
    }).annotate({ message: TIME_RULE }),
  ),
);
export type ScreenTruthItem = typeof ScreenTruthItem["Type"];

export const ForbiddenItem = Schema.Struct({
  text: Schema.optionalKey(Schema.String),
  slide: Schema.optionalKey(Schema.String),
  keywords: keywordsField,
}).annotate({ message: KEYWORDS_RULE });
export type ForbiddenItem = typeof ForbiddenItem["Type"];

const screenList = <S extends Schema.Top>(item: S) =>
  Schema.mutableKey(Schema.mutable(Schema.Array(item)).annotate({ message: KIND_LIST_RULE })).annotateKey({
    messageMissingKey: KIND_LIST_RULE,
  });

export const ScreenTruth = Schema.Struct({
  指す発言: screenList(ScreenTruthItem),
  話だけ: screenList(ScreenTruthItem),
  出てはいけない: screenList(ForbiddenItem),
}).annotate({ message: TRUTH_OBJECT_RULE });
export type ScreenTruth = typeof ScreenTruth["Type"];

export type Metrics = { nodes: number; depth: number; byKind: Record<Kind, number> };
export type Recall = { hit: number; total: number };
export type Run = { name: string; title: string; exp: JsonExport; log?: readonly LogEvent[] }; // log は log.jsonl の行（無いランは省く）

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
// cli eval と bench は共有の readTruthFile で Truth の Schema から読む。この手書きの検証は既存のテストが使うので残す
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
// keyword は文字列なら 1 語、配列なら言い換えの候補（どれか 1 つ）。本文は正規化済みで渡す
const containsKeyword = (body: string, keyword: Keyword) =>
  (Array.isArray(keyword) ? keyword : [keyword]).some((alt) => body.includes(normalize(alt)));

const matches = (node: ExportNode, { from, to, keywords }: Pick<TruthItem, "from" | "to" | "keywords">) => {
  const body = normalize(node.text);
  return node.evidence.some((r) => r.start <= to && r.end >= from) && keywords.every((k) => containsKeyword(body, k));
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

const allNodes = (exp: JsonExport): ExportNode[] => {
  const nodes: ExportNode[] = [];
  walk(exp.root, 0, (n) => nodes.push(n));
  return nodes;
};

// 同じ種別のノードと正解を 1 対 1 で対応させ、当たる件数が最大になる割り当ての件数を再現できた数とする（当たる条件は matches）
export function recall(exp: JsonExport, truth: Truth): Record<TruthKind, Recall> {
  const nodes = allNodes(exp);
  return Object.fromEntries(
    TRUTH_KINDS.map((kind) => {
      const sameKind = nodes.filter((n) => n.kind === kind);
      const candidates = truth[kind].map((item) => sameKind.flatMap((n, i) => (matches(n, item) ? [i] : [])));
      return [kind, { hit: maxMatching(candidates, sameKind.length), total: truth[kind].length }];
    }),
  ) as Record<TruthKind, Recall>;
}

export type ScreenScore = {
  pointing: Recall; // 指す発言
  memory: Recall; // うち記憶（memory が true の指す発言のうち取れた数）
  talkOnly: Recall; // 話だけ
  leaked: Recall; // 出てはいけない（hit は漏れた項目の数）
};

// 共有画面の正解の採点。ノードは種別で絞らず、指す発言・話だけはそれぞれ matches と 1 対 1 の割り当て（maxMatching）で別々に数える。
// うち記憶は memory が true の項目だけで先に割り当てる。増加路法は割り当て済みの正解を外さないので、指す発言の数と食い違わない。
// 出てはいけないは時刻を見ず、keywords のどれか 1 つ（言い換えならそのどれか）を含むノードが 1 つでもあれば漏れ
export function screenScore(exp: JsonExport, screen: ScreenTruth): ScreenScore {
  const nodes = allNodes(exp);
  const candidatesOf = (items: readonly ScreenTruthItem[]) =>
    items.map((item) => nodes.flatMap((n, i) => (matches(n, item) ? [i] : [])));
  const pointing = candidatesOf(screen.指す発言);
  const memoryCandidates = pointing.filter((_, i) => screen.指す発言[i]?.memory === true);
  const talkOnly = candidatesOf(screen.話だけ);
  const bodies = nodes.map((n) => normalize(n.text));
  const leaked = screen.出てはいけない.filter(({ keywords }) =>
    bodies.some((body) => keywords.some((k) => containsKeyword(body, k)))
  ).length;
  return {
    pointing: { hit: maxMatching(pointing, nodes.length), total: pointing.length },
    memory: { hit: maxMatching(memoryCandidates, nodes.length), total: memoryCandidates.length },
    talkOnly: { hit: maxMatching(talkOnly, nodes.length), total: talkOnly.length },
    leaked: { hit: leaked, total: screen.出てはいけない.length },
  };
}

const SCREEN_HEADERS = ["指す発言", "うち記憶", "話だけ", "出てはいけない"];
const formatCount = ({ hit, total }: Recall) => `${hit}/${total}`;

const RECALL_HEADERS: Record<TruthKind, string> = { 決定: "決定の再現率", TODO: "TODO の再現率" };

// log.jsonl から数える 3 指標の見出しと値。ログが無いランは - にする。書き換え/発言は n/m (0.xx)（発言が 0 件なら 0/0）
const LOG_HEADERS = ["書き換え/発言", "1 ノードの書き換えの最多", "話し中の兄弟の最多"];
function formatLogMetrics(log: readonly LogEvent[] | undefined): string[] {
  if (!log) return LOG_HEADERS.map(() => "-");
  const m = logMetrics(log);
  const ratio = m.remarks === 0 ? "0/0" : `${m.rewrites}/${m.remarks} (${(m.rewrites / m.remarks).toFixed(2)})`;
  return [ratio, String(m.maxRewritesPerNode), String(m.maxOpenSiblings)];
}

const formatRecall = ({ hit, total }: Recall) => (total === 0 ? "0/0" : `${hit}/${total} (${Math.round((hit / total) * 100)}%)`);

// 表のセルに入れる文字列。区切りの `|` と、その直前の `\` をエスケープし、改行は空白 1 つにして 1 行に保つ
const escapeCell = (cell: string) => cell.replace(/[\\|]/g, "\\$&").replace(/\r\n|\r|\n/g, " ");

// 1 ラン 1 行の Markdown の表（cli eval の標準出力）。truth があるときだけ、決定・TODO の再現率の列を足す。
// 再現率の分子は recall が数える「当たった件数」で、当たる条件は matches、1 対 1 の割り当ては maxMatching が持つ
// screen があるときは、その後ろに共有画面の 4 列（取れた数/項目数。出てはいけないは漏れた項目の数/項目数）を足す
export function formatTable(runs: Run[], truth?: Truth, screen?: ScreenTruth): string {
  const header = [
    "ラン", "会議", "ノード", "深さ", ...KINDS, ...LOG_HEADERS,
    ...(truth ? TRUTH_KINDS.map((k) => RECALL_HEADERS[k]) : []),
    ...(screen ? SCREEN_HEADERS : []),
  ];
  const rows = runs.map(({ name, title, exp, log }) => {
    const m = measure(exp);
    const recalls = truth ? TRUTH_KINDS.map((k) => formatRecall(recall(exp, truth)[k])) : [];
    const scores = screen ? Object.values(screenScore(exp, screen)).map(formatCount) : [];
    return [name, title, m.nodes, m.depth, ...KINDS.map((k) => m.byKind[k]), ...formatLogMetrics(log), ...recalls, ...scores].map(String);
  });
  const line = (cells: string[]) => `| ${cells.map(escapeCell).join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join("\n") + "\n";
}
