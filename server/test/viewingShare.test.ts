// 閲覧の共有の純粋な部分（Issue #834）。cloudflared の出力からのホスト名の取り出しと、cli の表示。
// 状態の型は 無し・共有中・切れた の 3 つ（切れたへの遷移は #837）。
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { formatShareAlreadyOpen, formatShareOpened, formatShareStatus, quickTunnelHostname, ShareStatus } from "../src/core/index.ts";

describe("quickTunnelHostname", () => {
  it("quick tunnel の URL を含む行から、ハイフンを含むラベルのホスト名を取る", () => {
    expect(quickTunnelHostname("2026-10-11T00:00:00Z INF |  https://quiet-river-fox-9.trycloudflare.com  |")).toBe("quiet-river-fox-9.trycloudflare.com");
    expect(quickTunnelHostname("https://abc-def.trycloudflare.com")).toBe("abc-def.trycloudflare.com");
  });

  it("api.trycloudflare.com や、URL の無い行からは取らない", () => {
    expect(quickTunnelHostname("INF Requesting new quick Tunnel on trycloudflare.com...")).toBeUndefined();
    expect(quickTunnelHostname("failed to request quick Tunnel: Post \"https://api.trycloudflare.com/tunnel\": EOF")).toBeUndefined();
    expect(quickTunnelHostname("https://example.com")).toBeUndefined();
    expect(quickTunnelHostname("")).toBeUndefined();
  });
});

describe("ShareStatus（状態の型は 3 つ）", () => {
  const decode = Schema.decodeUnknownSync(ShareStatus);

  it("無し・共有中・切れた を読める", () => {
    expect(decode({ status: "off" })).toEqual({ status: "off" });
    expect(decode({ status: "open", url: "https://a-b.trycloudflare.com", allow: "anyone" })).toEqual({ status: "open", url: "https://a-b.trycloudflare.com", allow: "anyone" });
    expect(decode({ status: "broken", allow: "anyone" })).toEqual({ status: "broken", allow: "anyone" });
  });

  it("未知の状態、URL の無い共有中は読めない", () => {
    expect(() => decode({ status: "closed" })).toThrow();
    expect(() => decode({ status: "open", allow: "anyone" })).toThrow();
  });
});

describe("cli の表示", () => {
  const open = { status: "open", url: "https://a-b.trycloudflare.com", allow: "anyone" } as const;

  it("formatShareStatus: 無しは「閲覧の共有: 無し」の 1 行", () => {
    expect(formatShareStatus({ status: "off" }).trimEnd()).toBe("閲覧の共有: 無し");
  });

  it("formatShareStatus: 共有中は状態・URL・許可の範囲を行で出す", () => {
    expect(formatShareStatus(open).trimEnd().split("\n")).toEqual([
      "閲覧の共有: 共有中", "URL: https://a-b.trycloudflare.com", "許可の範囲: 誰でも",
    ]);
  });

  it("formatShareStatus: 切れたは「切れた」と許可の範囲を出し、URL は出さない", () => {
    const text = formatShareStatus({ status: "broken", allow: "anyone" });
    expect(text).toContain("切れた");
    expect(text).toContain("許可の範囲: 誰でも");
    expect(text).not.toContain("http");
  });

  it("formatShareOpened: URL・許可の範囲・稼働の保証が無い旨の 3 行", () => {
    const lines = formatShareOpened(open).trimEnd().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("https://a-b.trycloudflare.com");
    expect(lines[1]).toContain("誰でも");
    expect(lines[2]).toContain("保証");
  });
});

describe("formatShareAlreadyOpen（すでに共有中のときの share の標準エラー）", () => {
  it("1 行で、すでに開いていること・新しくは開かないこと・今の URL と許可の範囲を含む", () => {
    const text = formatShareAlreadyOpen({ status: "open", url: "https://a-b.trycloudflare.com", allow: "anyone" });
    expect(text.trimEnd().split("\n")).toHaveLength(1);
    expect(text).toContain("すでに");
    expect(text).toContain("新しくは開きません");
    expect(text).toContain("https://a-b.trycloudflare.com");
    expect(text).toContain("誰でも");
  });
});
