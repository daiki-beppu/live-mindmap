import { describe, expect, it } from "vitest";
import { intakeNoticeText, RESUMED_NOTICE_MS, type IntakeStatus } from "../src/intake.ts";

// Issue #161: 画面の一言の規則（order.md:83-91）。サーバーは現在の状態だけを送り、ブラウザが
// 「途切れ／止まった → 動いている」の遷移から「再開しました」を導く（計画の採用案）。
// この純粋関数は、直前の状態・今の状態・今の状態になってからの経過時間（ms）から、出す文（なければ null）を決める。

const STATUSES: IntakeStatus[] = ["running", "interrupted", "stopped"];

describe("intakeNoticeText（画面に出す一言の規則）", () => {
  it("途切れている間は「音声の取り込みが途切れました。再開しています」を出し続ける（経過時間に関わらず）", () => {
    for (const previous of [null, "running", "interrupted"] as (IntakeStatus | null)[]) {
      for (const msSinceChange of [0, 1, RESUMED_NOTICE_MS, RESUMED_NOTICE_MS * 10]) {
        expect(intakeNoticeText({ previous, current: "interrupted", msSinceChange })).toBe("音声の取り込みが途切れました。再開しています");
      }
    }
  });

  it("止まった状態では「音声の取り込みが止まっています」を出し続ける（経過時間に関わらず）", () => {
    for (const previous of [null, "running", "interrupted", "stopped"] as (IntakeStatus | null)[]) {
      for (const msSinceChange of [0, 1, RESUMED_NOTICE_MS, RESUMED_NOTICE_MS * 10]) {
        expect(intakeNoticeText({ previous, current: "stopped", msSinceChange })).toBe("音声の取り込みが止まっています");
      }
    }
  });

  it("途切れ・止まった状態から動いている状態へ戻った直後は「再開しました」を出す", () => {
    expect(intakeNoticeText({ previous: "interrupted", current: "running", msSinceChange: 0 })).toBe("再開しました");
    expect(intakeNoticeText({ previous: "stopped", current: "running", msSinceChange: 0 })).toBe("再開しました");
  });

  it("「再開しました」は RESUMED_NOTICE_MS を境に消える（境界値）", () => {
    expect(intakeNoticeText({ previous: "interrupted", current: "running", msSinceChange: RESUMED_NOTICE_MS })).toBe("再開しました");
    expect(intakeNoticeText({ previous: "interrupted", current: "running", msSinceChange: RESUMED_NOTICE_MS + 1 })).toBeNull();
  });

  it("接続直後（previous が null）に、すでに動いている状態なら「再開しました」は出ない。常に出続けるわけではない", () => {
    expect(intakeNoticeText({ previous: null, current: "running", msSinceChange: 0 })).toBeNull();
  });

  it("途切れ・止まった状態を経ずに、ただ動いている状態が続くだけでは何も出ない", () => {
    expect(intakeNoticeText({ previous: "running", current: "running", msSinceChange: 0 })).toBeNull();
    expect(intakeNoticeText({ previous: "running", current: "running", msSinceChange: 100_000 })).toBeNull();
  });

  it("RESUMED_NOTICE_MS は正の定数（「数秒」を具体化したもの）", () => {
    expect(RESUMED_NOTICE_MS).toBeGreaterThan(0);
  });

  it("セッションが終わった（none）ときは、直前が途切れ・止まった状態でも「再開しました」にならず、何も出さない", () => {
    // running と違い、none への遷移は「再開した」として扱わない（セッションが終わっただけなのに
    // 「再開しました」と表示される回帰を防ぐ。companion 指摘: stop() が接続中のクライアントへ送る
    // フレームが running だと、直前 interrupted/stopped から running への遷移を誤って再開と解釈してしまう）
    for (const previous of ["interrupted", "stopped"] as (IntakeStatus | null)[]) {
      for (const msSinceChange of [0, 1, RESUMED_NOTICE_MS]) {
        expect(intakeNoticeText({ previous, current: "none", msSinceChange })).toBeNull();
      }
    }
  });

  it("3 つの状態の文はそれぞれ異なる（取り違えない）", () => {
    const texts = new Set(
      STATUSES.flatMap((current) => [
        intakeNoticeText({ previous: "running", current, msSinceChange: 0 }),
        intakeNoticeText({ previous: "interrupted", current, msSinceChange: 0 }),
      ]).filter((t): t is string => t !== null),
    );
    expect(texts.size).toBe(3); // 途切れ・止まった・再開しました
  });
});
