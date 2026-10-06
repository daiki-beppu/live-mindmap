import { describe, expect, it } from "vitest";
import { IntakeNotice } from "../src/IntakeNotice.tsx";
import { findAll, textOf } from "./tree.ts";

// Issue #161: 字幕（Captions）の横に出す、取り込みの状態の一言（order.md:85-88）。
// hooks を持たない部品として関数で直接呼ぶ（既存の Captions.test.tsx と同じ手法）。
// 文そのものの規則（途切れ／止まった／再開しました）は web/test/intake.test.ts が確かめるので、
// ここでは「渡された文を描くか・描かないか」という部品としての契約だけを確かめる。
describe("IntakeNotice: 取り込みの状態の一言", () => {
  it("出す文がなければ（null）何も描かない", () => {
    expect(IntakeNotice({ text: null })).toBeNull();
  });

  it("文があれば、その文をそのまま描く", () => {
    const tree = IntakeNotice({ text: "音声の取り込みが途切れました。再開しています" });
    expect(textOf(tree)).toContain("音声の取り込みが途切れました。再開しています");
  });

  it("バッジや影のための種別クラス・色を持たず、控えめな一言として描く（デザインの制約: バッジや影を重ねない）", () => {
    const tree = IntakeNotice({ text: "音声の取り込みが止まっています" });
    const divs = findAll(tree, "div");
    for (const div of divs) {
      const className = String(div.props.className ?? "");
      expect(className).not.toMatch(/badge|shadow/i);
    }
  });
});
