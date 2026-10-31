import { Effect, Predicate, Record as Rec, Schema, Struct } from "effect";
import type { ExportNode, JsonExport } from "./export.ts";
import { logMetrics } from "./logMetrics.ts";
import { KINDS, type Kind } from "./map.ts";
import { escapeCell } from "./markdownTable.ts";
import type { LogEvent } from "./session.ts";

const normalize = (s: string) => s.normalize("NFKC").replace(/\s/g, "");

const isWord = (v: unknown): v is string => typeof v === "string" && normalize(v) !== "";

const TRUTH_OBJECT_RULE = "正解はオブジェクトで書く";
const kindListRule = (kind: string) => `「${kind}」は配列で書く`;
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

// Finite は check を持つので annotate が check に付き、型の不一致（InvalidType）の文面にならない。Union で包んで型の不一致にも TIME_RULE を付ける
const seconds = Schema.Union([Schema.Finite]).annotate({ message: TIME_RULE }).annotateKey({ messageMissingKey: TIME_RULE });

// 時刻の前後だけを、下の Struct より前に見る段。struct の check は全プロパティが通ったときにだけ走るので
// （effect 4.0.6 の interpreter）、ここを struct の check にすると同じ項目の keywords の失敗が先に出てしまい、
// 失敗の理由の順（from / to の型 → from <= to → keywords）が入れ替わる。
// from / to が数でない間はここを通し、型の文面は下の Struct（seconds）に任せる
const itemTimeOrder = Schema.Unknown.check(
  Schema.makeFilter((item) =>
    !Predicate.isObject(item) || !Predicate.isNumber(item.from) || !Predicate.isNumber(item.to)
    || item.from <= item.to || TIME_ORDER_RULE
  ),
);

const keywordsField = Schema.mutable(Schema.Array(Keyword)).annotate({ message: KEYWORDS_RULE }).check(atLeastOne).annotateKey({
  messageMissingKey: KEYWORDS_RULE,
});
const matchFields = {
  text: Schema.optionalKey(Schema.String),
  from: seconds,
  to: seconds,
  keywords: keywordsField,
};

export const TruthItem = itemTimeOrder.pipe(
  Schema.decodeTo(Schema.Struct(matchFields).annotate({ message: TIME_RULE })),
);
export type TruthItem = typeof TruthItem["Type"];

export const TRUTH_KINDS = ["決定", "TODO"] as const satisfies readonly Kind[];
export type TruthKind = (typeof TRUTH_KINDS)[number];

const kindList = <S extends Schema.Top>(item: S, kind: string) =>
  Schema.mutableKey(Schema.mutable(Schema.Array(item)).annotate({ message: kindListRule(kind) })).annotateKey({
    messageMissingKey: kindListRule(kind),
  });
type KindList<S extends Schema.Top> = ReturnType<typeof kindList<S>>;

const kindLists = <F extends { readonly [kind: string]: Schema.Top }>(items: F) =>
  Rec.map(items, kindList) as { readonly [K in keyof F]: KindList<F[K]> };

export const Truth = Schema.Struct(kindLists(Struct.Record(TRUTH_KINDS, TruthItem))).annotate({
  message: TRUTH_OBJECT_RULE,
});
export type Truth = typeof Truth["Type"];

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

export const ScreenTruth = Schema.Struct(
  kindLists({ 指す発言: ScreenTruthItem, 話だけ: ScreenTruthItem, 出てはいけない: ForbiddenItem }),
).annotate({ message: TRUTH_OBJECT_RULE });
export type ScreenTruth = typeof ScreenTruth["Type"];

export type Metrics = { nodes: number; depth: number; byKind: Record<Kind, number> };
export type Recall = { hit: number; total: number };
export type Run = { name: string; title: string; exp: JsonExport; log?: readonly LogEvent[] };

const walk = (node: ExportNode, depth: number, visit: (n: ExportNode, depth: number) => void) => {
  for (const c of node.children) {
    visit(c, depth + 1);
    walk(c, depth + 1, visit);
  }
};

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

const containsKeyword = (body: string, keyword: Keyword) =>
  (Array.isArray(keyword) ? keyword : [keyword]).some((alt) => body.includes(normalize(alt)));

const matches = (node: ExportNode, { from, to, keywords }: Pick<TruthItem, "from" | "to" | "keywords">) => {
  const body = normalize(node.text);
  return node.evidence.some((r) => r.start <= to && r.end >= from) && keywords.every((k) => containsKeyword(body, k));
};

function maxMatching(candidates: number[][], nodeCount: number): Array<{ truth: number; node: number }> {
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
  candidates.forEach((_, t) => assign(t, Array.from({ length: nodeCount }, () => false)));
  return owner.flatMap((truth, node) => truth === -1 ? [] : [{ truth, node }]);
}

const allNodes = (exp: JsonExport): ExportNode[] => {
  const nodes: ExportNode[] = [];
  walk(exp.root, 0, (n) => nodes.push(n));
  return nodes;
};

export function matchTruth<T extends TruthItem>(exp: JsonExport, kind: Kind, items: readonly T[]): Array<{ truth: T; node: ExportNode }> {
  const nodes = allNodes(exp).filter((n) => n.kind === kind);
  const candidates = items.map((item) => nodes.flatMap((n, i) => matches(n, item) ? [i] : []));
  return maxMatching(candidates, nodes.length).map(({ truth, node }) => ({ truth: items[truth]!, node: nodes[node]! }));
}

export function recall(exp: JsonExport, truth: Truth): Record<TruthKind, Recall> {
  return Object.fromEntries(
    TRUTH_KINDS.map((kind) => {
      return [kind, { hit: matchTruth(exp, kind, truth[kind]).length, total: truth[kind].length }];
    }),
  ) as Record<TruthKind, Recall>;
}

export function wrongKind(exp: JsonExport, truth: Truth): Record<TruthKind, number> {
  const nodes = allNodes(exp);
  const same = recall(exp, truth);
  return Object.fromEntries(
    TRUTH_KINDS.map((kind) => {
      const candidates = truth[kind].map((item) => nodes.flatMap((n, i) => (matches(n, item) ? [i] : [])));
      return [kind, maxMatching(candidates, nodes.length).length - same[kind].hit];
    }),
  ) as Record<TruthKind, number>;
}

export type ScreenScore = {
  pointing: Recall;
  memory: Recall;
  talkOnly: Recall;
  leaked: Recall;
};

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
    pointing: { hit: maxMatching(pointing, nodes.length).length, total: pointing.length },
    memory: { hit: maxMatching(memoryCandidates, nodes.length).length, total: memoryCandidates.length },
    talkOnly: { hit: maxMatching(talkOnly, nodes.length).length, total: talkOnly.length },
    leaked: { hit: leaked, total: screen.出てはいけない.length },
  };
}

const SCREEN_HEADERS = ["指す発言", "うち記憶", "話だけ", "出てはいけない"];
const formatCount = ({ hit, total }: Recall) => `${hit}/${total}`;

const RECALL_HEADERS: Record<TruthKind, string> = { 決定: "決定の再現率", TODO: "TODO の再現率" };
const WRONG_KIND_HEADERS: Record<TruthKind, string> = { 決定: "決定の種別違い", TODO: "TODO の種別違い" };

const LOG_HEADERS = ["書き換え/発言", "1 ノードの書き換えの最多", "話し中の兄弟の最多"];
const formatLogMetrics = Effect.fnUntraced(function* (log: readonly LogEvent[] | undefined) {
  if (!log) return LOG_HEADERS.map(() => "-");
  const m = yield* logMetrics(log);
  const ratio = m.remarks === 0 ? "0/0" : `${m.rewrites}/${m.remarks} (${(m.rewrites / m.remarks).toFixed(2)})`;
  return [ratio, String(m.maxRewritesPerNode), String(m.maxOpenSiblings)];
});

const formatRecall = ({ hit, total }: Recall) => (total === 0 ? "0/0" : `${hit}/${total} (${Math.round((hit / total) * 100)}%)`);

const USAGE_HEADERS = ["入力トークン", "キャッシュ書き込みトークン", "キャッシュ読み出しトークン", "出力トークン"];
const TABLE_KINDS = KINDS.filter((kind) => kind !== "補足");
function formatUsage(log: readonly LogEvent[] | undefined): string[] {
  const usages = (log ?? []).flatMap((e) => (e.type === "diff" && e.usage ? [e.usage] : []));
  if (usages.length === 0) return USAGE_HEADERS.map(() => "-");
  const sum = (pick: (u: (typeof usages)[number]) => number) => String(usages.reduce((a, u) => a + pick(u), 0));
  return [sum((u) => u.input), sum((u) => u.cacheWrite), sum((u) => u.cacheRead), sum((u) => u.output)];
}

export const formatTable = Effect.fnUntraced(function* (runs: Run[], truth?: Truth, screen?: ScreenTruth) {
  const header = [
    "ラン", "会議", "ノード", "深さ", ...TABLE_KINDS, ...LOG_HEADERS, ...USAGE_HEADERS,
    ...(truth ? [...TRUTH_KINDS.map((k) => RECALL_HEADERS[k]), ...TRUTH_KINDS.map((k) => WRONG_KIND_HEADERS[k])] : []),
    ...(screen ? SCREEN_HEADERS : []),
  ];
  const rows = yield* Effect.forEach(runs, Effect.fnUntraced(function* ({ name, title, exp, log }) {
    const m = measure(exp);
    const recalls = truth ? TRUTH_KINDS.map((k) => formatRecall(recall(exp, truth)[k])) : [];
    const wrongKinds = truth ? TRUTH_KINDS.map((k) => String(wrongKind(exp, truth)[k])) : [];
    const scores = screen ? Object.values(screenScore(exp, screen)).map(formatCount) : [];
    return [name, title, m.nodes, m.depth, ...TABLE_KINDS.map((k) => m.byKind[k]), ...(yield* formatLogMetrics(log)), ...formatUsage(log), ...recalls, ...wrongKinds, ...scores].map(String);
  }));
  const line = (cells: string[]) => `| ${cells.map(escapeCell).join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join("\n") + "\n";
});
