import { describe, expect, it } from "vitest";
import { diffFailureMessage } from "../src/core/diffFailureMessage.ts";

describe("公開する差分更新の失敗文面", () => {
  it("秘密のない説明を残し、改行を一行にする", () => {
    expect(diffFailureMessage("認証に失敗しました\n接続を確認してください")).toBe("認証に失敗しました 接続を確認してください");
  });

  it.each([
    'api_key="AlphaSecret1980 BravoSecret1980"',
    "API-KEY='AlphaSecret1980 BravoSecret1980'",
    '"access_token": "AlphaSecret1980BravoSecret1980"',
    "password=AlphaSecret1980BravoSecret1980",
    "Authorization: bEaReR AlphaSecret1980BravoSecret1980",
    "Authorization: Basic AlphaSecret1980BravoSecret1980",
    "sk-ant-AlphaSecret1980BravoSecret1980",
    "sess-AlphaSecret1980BravoSecret1980",
    "https://user:AlphaSecret1980BravoSecret1980@example.test/path",
    "https://example.test/?token=AlphaSecret1980BravoSecret1980&mode=test",
  ])("資格情報を伏せ、失敗の説明を残す: %s", (credential) => {
    const out = diffFailureMessage(`認証に失敗しました ${credential}`);
    expect(out).toContain("認証に失敗しました");
    const normalized = out.toLowerCase().replace(/[^a-z0-9]/g, "");
    expect(normalized).not.toContain("alphasecret1980");
    expect(normalized).not.toContain("bravosecret1980");
  });

  it("複数の秘密と JWT を同じ文面で伏せる", () => {
    const out = diffFailureMessage("認証失敗 api_key=AlphaSecret1980 password=BravoSecret1980 eyJhbGciOiJIUzI1NiJ9.payload.signature");
    expect(out).toContain("認証失敗");
    expect(out).not.toMatch(/AlphaSecret1980|BravoSecret1980|eyJhbGci|payload|signature/i);
  });
});
