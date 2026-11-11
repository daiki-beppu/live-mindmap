import { describe, expect, it } from "vitest";
import { intakeNoticeText, RESUMED_NOTICE_MS, type IntakeStatus } from "../src/intake.ts";

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
    expect(texts.size).toBe(3);
  });
});
