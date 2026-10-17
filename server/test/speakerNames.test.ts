import { describe, expect, it } from "vitest";
import { nameSpeaker } from "../src/core/index.ts";

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

    expect(nameSpeaker(current, { label: "相手 B", name: "鈴木", source: "推定" })).toBeUndefined();
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

    const next = nameSpeaker(current, { label: "相手 B", name: "鈴木", source: "推定" });

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
