import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { formatTable, matchTruth, measure, recall, screenScore, Truth, wrongKind } from "../src/core/evaluate.ts";
import type { ExportNode, JsonExport } from "../src/core/export.ts";
import { toJsonExport } from "../src/core/export.ts";
import { reviewSnapshot, type LogEvent } from "../src/core/index.ts";

describe("正解とノードの最終割り当て", () => {
  it("決定・TODOの再現率と種別違いには補足を使わず、通常の別種別は数える", () => {
    const node = (id: string, kind: ExportNode["kind"], text: string, children: ExportNode[] = []): ExportNode => {
      const common = { id, text, children, evidence: [{ id: "r1", track: "相手" as const, start: 10, end: 20, text: "根拠" }] };
      return kind === "補足" ? { ...common, kind, origin: "会議の外" } : { ...common, kind };
    };
    const exp: JsonExport = { root: node("root", "会議", "会議", [
      node("n1", "決定", "予算"), node("n2", "TODO", "調査"),
      node("n3", "案", "上限 面接", [node("n4", "補足", "SLA 求人票")]),
    ]) };
    const item = (word: string) => ({ from: 10, to: 20, keywords: [word] });
    const truth = { 決定: [item("予算"), item("上限"), item("SLA")], TODO: [item("調査"), item("面接"), item("求人票")] };
    expect(recall(exp, truth)).toEqual({ 決定: { hit: 1, total: 3 }, TODO: { hit: 1, total: 3 } });
    expect(wrongKind(exp, truth)).toEqual({ 決定: 1, TODO: 1 });
    expect(measure(exp)).toMatchObject({ nodes: 3, depth: 1, byKind: { 決定: 1, TODO: 1, 案: 1, 補足: 0 } });
  });

  it("共有画面の評価からも補足を除き、同じ語を含む通常ノードは照合する", () => {
    const evidence: ExportNode["evidence"] = [{ id: "r1", track: "相手", start: 10, end: 20, text: "根拠" }];
    const exp: JsonExport = { root: { id: "root", kind: "会議", text: "会議", evidence: [], children: [
      { id: "n1", kind: "案", text: "補足の方法", evidence, children: [
        { id: "n2", kind: "補足", text: "SLA", origin: "会議の外", evidence, children: [] },
      ] },
    ] } };
    const item = (word: string) => ({ from: 10, to: 20, keywords: [word], memory: true });
    expect(screenScore(exp, {
      指す発言: [item("SLA"), item("補足の方法")], 話だけ: [item("SLA"), item("補足の方法")],
      出てはいけない: [{ keywords: ["SLA"] }, { keywords: ["補足の方法"] }],
    })).toEqual({ pointing: { hit: 1, total: 2 }, memory: { hit: 1, total: 2 }, talkOnly: { hit: 1, total: 2 }, leaked: { hit: 1, total: 2 } });
  });

  it("先の正解を別ノードへ移し、拡張項目を保持した一対一の最終組を返す", () => {
    const node = (id: string, text: string): ExportNode => ({
      id, kind: "TODO", text, children: [],
      evidence: [{ id: "r1", track: "相手", start: 0, end: 1, text: "根拠" }],
    });
    const both = node("n1", "予算の上限");
    const onlyBudget = node("n2", "予算");
    const exp: JsonExport = { root: { id: "root", kind: "会議", text: "会議", evidence: [], children: [both, onlyBudget] } };
    const budget = { from: 0, to: 1, keywords: ["予算"], 担当: "甲" };
    const limit = { from: 0, to: 1, keywords: ["上限"], 担当: "乙" };
    const items = [budget, limit];
    const pairs = matchTruth(exp, "TODO", items);
    expect(pairs).toHaveLength(2);
    expect(pairs).toEqual(expect.arrayContaining([
      { truth: budget, node: onlyBudget },
      { truth: limit, node: both },
    ]));
    expect(recall(exp, { 決定: [], TODO: items }).TODO).toEqual({ hit: 2, total: 2 });
  });
});

describe("補足を独立して評価する表", () => {
  const node = (id: string, text: string, children: ExportNode[] = []): ExportNode => ({
    id, kind: "案", text, children,
    evidence: [{ id: "r1", track: "相手", start: 10, end: 20, text: "根拠" }],
  });
  const supplement: ExportNode = {
    ...node("s1", "用語の説明"), kind: "補足", origin: "会議の外",
  };
  const tableRow = Effect.fnUntraced(function* (exp: JsonExport, log: LogEvent[] | undefined, truth: unknown) {
    const table = yield* formatTable([{ name: "合成ラン", title: "合成会議", exp, ...(log === undefined ? {} : { log }) }],
      Schema.decodeUnknownSync(Truth)(truth));
    const cells = (line: string) => line.split("|").slice(1, -1).map((cell) => cell.trim());
    const lines = table.trim().split("\n");
    const header = cells(lines[0]!);
    return Object.fromEntries(cells(lines[2]!).map((value, i) => [header[i]!, value]));
  });
  const expOf = (children: ExportNode[]): JsonExport => ({ root: { id: "root", kind: "会議", text: "会議", evidence: [], children } });

  it.effect("正解の場面に付いた補足を数え、本文の一致だけでは再現としない", () => Effect.gen(function* () {
    const truth = { 決定: [], TODO: [], 補足: [{ from: 10, to: 20, keywords: ["SLA"] }] };
    const hit = yield* tableRow(expOf([node("n1", "SLAを決める", [supplement])]), undefined, truth);
    const miss = yield* tableRow(expOf([
      node("n1", "SLAを決める"), node("n2", "別の場面", [{ ...supplement, text: "SLA" }]),
    ]), undefined, truth);
    expect(hit["補足の再現率"]).toBe("1/1 (100%)");
    expect(miss["補足の再現率"]).toBe("0/1 (0%)");
  }));

  it.effect("補足が無い場面と時刻の異なる場面は取りこぼしに数える", () => Effect.gen(function* () {
    const truth = { 決定: [], TODO: [], 補足: [{ from: 30, to: 40, keywords: ["SLA"] }] };
    for (const children of [[node("n1", "SLA")], [node("n1", "SLA", [supplement])]]) {
      expect((yield* tableRow(expOf(children), undefined, truth))["補足の再現率"]).toBe("0/1 (0%)");
    }
  }));

  it.effect("補足の場面も最大一対一で照合し、同じ親を2件に数えない", () => Effect.gen(function* () {
    const exp = expOf([node("n1", "SLA 上限", [supplement]), node("n2", "SLA", [{ ...supplement, id: "s2" }])]);
    const items = ["SLA", "上限", "上限"].map((word) => ({ from: 10, to: 20, keywords: [word] }));
    expect((yield* tableRow(exp, undefined, { 決定: [], TODO: [], 補足: items }))["補足の再現率"]).toBe("2/3 (67%)");
  }));

  it.effect("補足キーの省略では再現率列を出さず、明示した空配列は0/0とする", () => Effect.gen(function* () {
    const exp = expOf([node("n1", "SLA", [supplement])]);
    expect(yield* tableRow(exp, undefined, { 決定: [], TODO: [] })).not.toHaveProperty("補足の再現率");
    expect((yield* tableRow(exp, undefined, { 決定: [], TODO: [], 補足: [] }))["補足の再現率"]).toBe("0/0");
  }));

  it.each([
    { 補足: null }, { 補足: {} }, { 補足: [{ from: 10, to: 20, keywords: [] }] },
    { 補足: [{ from: 20, to: 10, keywords: ["SLA"] }] },
  ])("不正な補足の正解を黙って捨てず拒否する: $補足", ({ 補足 }) => {
    expect(() => Schema.decodeUnknownSync(Truth)({ 決定: [], TODO: [], 補足 })).toThrow();
  });

  it.effect("追加・更新・削除・拒否を反映した最終補足から量と行由来の区分を数える", () => Effect.gen(function* () {
    const log: LogEvent[] = [
      { type: "start", title: "合成会議" },
      { type: "remark", remark: { id: "r1", track: "相手", start: 0, end: 10, text: "用語" } },
      { type: "diff", input: { recent: [], fresh: ["r1"], nodeCount: 0 }, dropped: [], ops: [
        ...["a", "b", "c"].map((ref) => ({ op: "add" as const, ref, parent: "root", kind: "案" as const, text: "案", evidence: ["r1"] })),
      ] },
      { type: "remark", remark: { id: "r2", track: "自分", start: 1790, end: 1800, text: "未引用" } },
      { type: "supplement", category: "用語", term: "ＳＬＡ", ms: 1, reflectedAt: 10,
        op: { op: "add", parent: "n1", text: "説明1", evidence: ["r1"], origin: "会議の外" } },
      { type: "supplement", category: "用語", term: "S L A", ms: 1, reflectedAt: 10,
        op: { op: "add", parent: "n2", text: "説明2", evidence: ["r1"], origin: "会議の外" } },
      { type: "supplement", category: "背景", ms: 1, reflectedAt: 10,
        op: { op: "update", node: "n5", text: "説明2の更新", evidence: ["r1"], origin: "会議の中" } },
      { type: "supplement", category: "理由", ms: 1, reflectedAt: 10,
        op: { op: "add", parent: "n3", text: "削除する説明", evidence: ["r1"], origin: "会議の外" } },
      { type: "supplement", category: null, ms: 1, reflectedAt: 10, op: { op: "delete", node: "n6" } },
      { type: "supplement", category: "推奨", ms: 1, reflectedAt: 10,
        op: { op: "add", parent: "n1", text: "既存補足があり拒否", evidence: ["r1"], origin: "会議の外" } },
    ];
    const exp = toJsonExport(reviewSnapshot(log), log.flatMap((event) => event.type === "remark" ? [event.remark] : []));
    const row = yield* tableRow(exp, log, { 決定: [], TODO: [] });
    expect(row["補足数"]).toBe("2");
    expect(Number(row["補足/時"])).toBe(4);
    expect(row["補足が付いた割合"]).toMatch(/67%|66\.7%/);
    expect(row["補足の同語重複"]).toBe("1");
    expect(row["補足の区分"]).toMatch(/用語\s*[:：=]\s*1/);
    expect(row["補足の区分"]).toMatch(/背景\s*[:：=]\s*1/);
    expect(row["補足の区分"]).not.toMatch(/理由\s*[:：=]\s*[1-9]|推奨\s*[:：=]\s*[1-9]/);
    expect(row["補足の出どころ"]).toMatch(/会議の中\s*[:：=]\s*1/);
    expect(row["補足の出どころ"]).toMatch(/会議の外\s*[:：=]\s*1/);
  }));

  it.effect("exportだけでも補足数と出どころを表示し、ログが必要な値は欠測とする", () => Effect.gen(function* () {
    const row = yield* tableRow(expOf([node("n1", "SLA", [supplement])]), undefined, { 決定: [], TODO: [] });
    expect(row["補足数"]).toBe("1");
    expect(row["補足の出どころ"]).toMatch(/会議の外\s*[:：=]\s*1/);
    for (const header of ["補足/時", "補足の区分", "補足の同語重複", "補足の遅れ p50 (秒)", "補足の入力トークン"]) {
      expect(row[header], header).toBe("-");
    }
  }));

  it.effect("補足が0件であることとusageの0を欠測と区別する", () => Effect.gen(function* () {
    const log: LogEvent[] = [
      { type: "start", title: "合成会議" },
      { type: "remark", remark: { id: "r1", track: "相手", start: 0, end: 3600, text: "発言" } },
      { type: "supplement", op: null, category: null, ms: 1, reflectedAt: 3600,
        usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, model: "synthetic" } },
    ];
    const row = yield* tableRow(expOf([]), log, { 決定: [], TODO: [], 補足: [{ from: 0, to: 1, keywords: ["SLA"] }] });
    expect(row["補足数"]).toBe("0");
    expect(Number(row["補足/時"])).toBe(0);
    expect(row["補足の再現率"]).toBe("0/1 (0%)");
    for (const header of ["補足の入力トークン", "補足のキャッシュ書き込みトークン", "補足のキャッシュ読み出しトークン", "補足の出力トークン"]) {
      expect(row[header], header).toBe("0");
    }
  }));
});
