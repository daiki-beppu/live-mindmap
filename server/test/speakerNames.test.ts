import { describe, expect, it } from "vitest";
import { acceptInferredNames, nameSpeaker, type InferredSpeakerName, type Remark } from "../src/core/index.ts";

// Issue #1026: 話者の名前の規則（GLOSSARY「話者の名前」、#610 の Alloy の manualNameSticks・namesNeverRemoved）。
// nameSpeaker(現在の表, 変更) は、表が変わるときだけ新しい表（ラベル → { name, source }）を返し、変わらないときは undefined を返す純粋な関数。
// 渡した表は書き換えない。出どころの「推定」は後の sub-issue が書く。今回の画面とサーバーが書くのは「手入力」だけで、規則はここで固める

const table = (...rows: Array<[string, string, "推定" | "手入力"]>) => new Map(rows.map(([label, name, source]) => [label, { name, source }] as const));

describe("nameSpeaker", () => {
  it("名前の無いラベルに名前が付く。渡した表は書き換えず、新しい表を返す", () => {
    const current = table();

    const next = nameSpeaker(current, { label: "相手 B", name: "田中", source: "手入力" });

    expect([...next!]).toEqual([["相手 B", { name: "田中", source: "手入力" }]]);
    expect(current.size).toBe(0);
  });

  it("同じ名前を 2 つのラベルに付けても、まとめない（ラベルごとに別の行のまま）", () => {
    const first = nameSpeaker(table(), { label: "相手 A", name: "田中", source: "手入力" })!;

    const next = nameSpeaker(first, { label: "相手 B", name: "田中", source: "手入力" })!;

    expect([...next.keys()]).toEqual(["相手 A", "相手 B"]);
    expect([...next.values()].map((v) => v.name)).toEqual(["田中", "田中"]);
  });

  it("manualNameSticks: 手入力の名前を、推定は替えない（変わらない）", () => {
    const current = table(["相手 B", "田中", "手入力"]);

    expect(nameSpeaker(current, { label: "相手 B", name: "鈴木", source: "推定", basis: "名乗り" })).toBeUndefined();
  });

  it("manualNameSticks: 手入力の名前は、手入力でなら替わる", () => {
    const current = table(["相手 B", "田中", "手入力"]);

    const next = nameSpeaker(current, { label: "相手 B", name: "鈴木", source: "手入力" });

    expect(next!.get("相手 B")).toEqual({ name: "鈴木", source: "手入力" });
  });

  it("推定の名前は、手入力で替わり、出どころも手入力になる", () => {
    const current = table(["相手 B", "たなか", "推定"]);

    const next = nameSpeaker(current, { label: "相手 B", name: "田中", source: "手入力" });

    expect(next!.get("相手 B")).toEqual({ name: "田中", source: "手入力" });
  });

  it("手入力の名前の替わらなさは、そのラベルだけ。別のラベルの推定は付く", () => {
    const current = table(["相手 A", "田中", "手入力"]);

    const next = nameSpeaker(current, { label: "相手 B", name: "鈴木", source: "推定", basis: "名乗り" });

    expect(next!.get("相手 A")).toEqual({ name: "田中", source: "手入力" });
    expect(next!.get("相手 B")).toEqual({ name: "鈴木", source: "推定" });
  });

  it("namesNeverRemoved: 空の名前・空白だけの名前では、付いた名前を外さない（変わらない）", () => {
    const current = table(["相手 B", "田中", "手入力"]);

    for (const name of ["", " ", "　", "\n"]) {
      expect([name, nameSpeaker(current, { label: "相手 B", name, source: "手入力" })]).toEqual([name, undefined]);
    }
  });

  it("名前の無いラベルに空の名前を入れても、何も付かない（変わらない）", () => {
    expect(nameSpeaker(table(), { label: "相手 B", name: "  ", source: "手入力" })).toBeUndefined();
  });

  it("同じ名前を同じ出どころで入れ直しても変わらない（ログもフレームも重ねない）", () => {
    const current = table(["相手 B", "田中", "手入力"]);

    expect(nameSpeaker(current, { label: "相手 B", name: "田中", source: "手入力" })).toBeUndefined();
  });
});

// Issue #1027: AI が付けた名前の付け替え（aiRenameOnlyBySelfIntro）。推定の変更は、根拠の種類 basis（名乗り / 呼びかけへの応答）を持つ。
// AI の名前を AI が付け替えるのは、新しい根拠が本人の名乗りのときだけ
describe("nameSpeaker: 推定の付け替え（aiRenameOnlyBySelfIntro）", () => {
  it("名前の無いラベルには、どちらの根拠でも推定の名前が付く", () => {
    for (const basis of ["名乗り", "呼びかけへの応答"] as const) {
      const next = nameSpeaker(table(), { label: "相手 B", name: "田中", source: "推定", basis });

      expect([basis, next!.get("相手 B")]).toEqual([basis, { name: "田中", source: "推定" }]);
    }
  });

  it("推定の名前を、呼びかけへの応答を根拠にした別の名前では付け替えない（変わらない）", () => {
    const current = table(["相手 B", "田中", "推定"]);

    expect(nameSpeaker(current, { label: "相手 B", name: "鈴木", source: "推定", basis: "呼びかけへの応答" })).toBeUndefined();
  });

  it("推定の名前を、名乗りを根拠にした別の名前では付け替える。出どころは推定のまま", () => {
    const current = table(["相手 B", "田中", "推定"]);

    const next = nameSpeaker(current, { label: "相手 B", name: "鈴木", source: "推定", basis: "名乗り" });

    expect(next!.get("相手 B")).toEqual({ name: "鈴木", source: "推定" });
    expect(current.get("相手 B")).toEqual({ name: "田中", source: "推定" });
  });

  it("手入力の名前は、名乗りを根拠にした推定でも替えない", () => {
    const current = table(["相手 B", "田中", "手入力"]);

    expect(nameSpeaker(current, { label: "相手 B", name: "鈴木", source: "推定", basis: "名乗り" })).toBeUndefined();
  });

  it("付け替えの制限は推定どうしだけ。手入力は、呼びかけへの応答で付いた推定の名前も替える", () => {
    const current = table(["相手 B", "田中", "推定"]);

    expect(nameSpeaker(current, { label: "相手 B", name: "鈴木", source: "手入力" })!.get("相手 B")).toEqual({ name: "鈴木", source: "手入力" });
  });

  it("推定どうしで同じ名前の入れ直しは、名乗りでも変わらない", () => {
    const current = table(["相手 B", "田中", "推定"]);

    expect(nameSpeaker(current, { label: "相手 B", name: "田中", source: "推定", basis: "名乗り" })).toBeUndefined();
  });

  it("namesNeverRemoved: 名乗りを根拠にしても、空の名前では推定の名前を外さない", () => {
    const current = table(["相手 B", "田中", "推定"]);

    expect(nameSpeaker(current, { label: "相手 B", name: "  ", source: "推定", basis: "名乗り" })).toBeUndefined();
  });

  it("手入力の名前を、推定が付け替えない。ほかのラベルの推定の付け替えにも影響しない", () => {
    const current = table(["相手 A", "山田", "手入力"], ["相手 B", "田中", "推定"]);

    const next = nameSpeaker(current, { label: "相手 B", name: "鈴木", source: "推定", basis: "名乗り" });

    expect(next!.get("相手 A")).toEqual({ name: "山田", source: "手入力" });
    expect(next!.get("相手 B")).toEqual({ name: "鈴木", source: "推定" });
  });
});

// サーバーが AI の名前を確かめる。通るのは、根拠の発言が消費済み（known）で、その発言が 相手 の発言かつ話者がラベルと一致する名前だけ
const remarkOf = (id: string, track: "自分" | "相手", speaker?: string): Remark => ({ id, track, start: 0, end: 1, text: "発言", ...(speaker !== undefined ? { speaker } : {}) });
const inferred = (label: string, evidence: string, name = "田中", basis: InferredSpeakerName["basis"] = "名乗り"): InferredSpeakerName => ({ label, name, evidence, basis });
const remarksById = (...remarks: Remark[]) => new Map(remarks.map((r) => [r.id, r]));

describe("acceptInferredNames", () => {
  const remarks = remarksById(remarkOf("r1", "相手", "相手 A"), remarkOf("r2", "相手", "相手 B"), remarkOf("r3", "自分", "自分"), remarkOf("r4", "相手"), remarkOf("r5", "相手", "相手 B"));
  const known = new Set(["r1", "r2", "r3", "r4"]); // r5 は発言の表にあるが、まだ消費していない

  it("根拠の発言が消費済みで、話者がラベルと一致する名前は通る。基準になった根拠の種類も残る", () => {
    const accepted = acceptInferredNames([inferred("相手 B", "r2", "田中", "名乗り"), inferred("相手 A", "r1", "鈴木", "呼びかけへの応答")], known, remarks);

    expect(accepted).toEqual([inferred("相手 B", "r2", "田中", "名乗り"), inferred("相手 A", "r1", "鈴木", "呼びかけへの応答")]);
  });

  it("根拠の発言が知らない id の名前は捨てる", () => {
    expect(acceptInferredNames([inferred("相手 B", "r99")], known, remarks)).toEqual([]);
  });

  it("根拠の発言が発言の表にあっても、消費済み（known）でなければ捨てる（話者は一致している）", () => {
    expect(acceptInferredNames([inferred("相手 B", "r5")], known, remarks)).toEqual([]);
  });

  it("根拠の発言の話者がラベルと違う名前は捨てる", () => {
    expect(acceptInferredNames([inferred("相手 B", "r1")], known, remarks)).toEqual([]);
  });

  it("自分には名前を付けない。自分の発言を根拠にしても、ラベル「自分」でも捨てる", () => {
    expect(acceptInferredNames([inferred("自分", "r3"), inferred("相手 B", "r3")], known, remarks)).toEqual([]);
  });

  it("track が自分の発言は、話者がラベルと一致していても根拠にならない", () => {
    const own = remarksById(remarkOf("r1", "自分", "相手 B"));

    expect(acceptInferredNames([inferred("相手 B", "r1")], new Set(["r1"]), own)).toEqual([]);
  });

  it("ラベルの無い 相手 の発言を根拠にした名前は捨てる（ラベル「相手」でも通らない）", () => {
    expect(acceptInferredNames([inferred("相手 B", "r4"), inferred("相手", "r4")], known, remarks)).toEqual([]);
  });

  it("通る名前と捨てる名前が混ざっても、通る名前だけを元の順序で返す。入力の配列は書き換えない", () => {
    const names = [inferred("相手 B", "r99"), inferred("相手 A", "r1"), inferred("相手 A", "r2"), inferred("相手 B", "r2", "鈴木")];

    const accepted = acceptInferredNames(names, known, remarks);

    expect(accepted).toEqual([inferred("相手 A", "r1"), inferred("相手 B", "r2", "鈴木")]);
    expect(names).toHaveLength(4);
  });

  it("名前が無ければ空を返す", () => {
    expect(acceptInferredNames([], known, remarks)).toEqual([]);
  });
});
