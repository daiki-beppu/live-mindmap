// 閲覧の共有の純粋な部分（Issue #834）。cloudflared の出力からのホスト名の取り出しと、cli の表示。
// 状態の型は 無し・共有中・切れた の 3 つ（切れたへの遷移は #837）。
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { formatShareAlreadyOpen, formatShareOpened, formatShareStatus, quickTunnelArgs, quickTunnelHostname, ShareStatus } from "../src/core/index.ts";
import { allowedMails } from "./fixtures/allowedMail.ts";

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

  it("許可の範囲はメール・ドメインの一覧（1 件以上）でも読める。空の一覧は読めない", () => {
    const mails = ["a@x.com", "*@example.co.jp"];
    expect(decode({ status: "open", url: "https://a-b.trycloudflare.com", allow: { mails } })).toEqual({ status: "open", url: "https://a-b.trycloudflare.com", allow: { mails } });
    expect(decode({ status: "broken", allow: { mails } })).toEqual({ status: "broken", allow: { mails } });
    expect(() => decode({ status: "open", url: "https://a-b.trycloudflare.com", allow: { mails: [] } })).toThrow();
    expect(() => decode({ status: "broken", allow: { mails: [] } })).toThrow();
    expect(() => decode({ status: "open", url: "https://a-b.trycloudflare.com", allow: "nobody" })).toThrow();
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

describe("メール・ドメインの範囲の表示", () => {
  const mails = { mails: ["a@x.com", "*@example.co.jp"] };
  const open = { status: "open", url: "https://a-b.trycloudflare.com", allow: mails } as const;

  it("formatShareStatus: 共有中・切れたの許可の範囲にメール・ドメインを並べる（誰でもとは出さない）", () => {
    expect(formatShareStatus(open).trimEnd().split("\n")).toEqual([
      "閲覧の共有: 共有中", "URL: https://a-b.trycloudflare.com", "許可の範囲: a@x.com, *@example.co.jp",
    ]);
    const broken = formatShareStatus({ status: "broken", allow: mails });
    expect(broken).toContain("許可の範囲: a@x.com, *@example.co.jp");
    expect(broken).not.toContain("誰でも");
  });

  it("formatShareOpened / formatShareAlreadyOpen: メール・ドメインを出し、誰でもとは出さない", () => {
    const opened = formatShareOpened(open).trimEnd().split("\n");
    expect(opened).toHaveLength(3);
    expect(opened[1]).toContain("a@x.com");
    expect(opened[1]).toContain("*@example.co.jp");
    expect(opened[1]).not.toContain("誰でも");
    const already = formatShareAlreadyOpen(open);
    expect(already).toContain("a@x.com");
    expect(already).toContain("*@example.co.jp");
    expect(already).not.toContain("誰でも");
  });
});

describe("quickTunnelArgs（cloudflared の引数）", () => {
  it("誰でもは --allowed-mail を付けず、ポートの URL だけを渡す", () => {
    const args = quickTunnelArgs(4321, "anyone");
    expect(args.slice(0, 3)).toEqual(["tunnel", "--url", "http://127.0.0.1:4321"]);
    expect(args).not.toContain("--allowed-mail");
  });

  it("メール・ドメインがあれば --allowed-mail で全部を渡す", () => {
    const args = quickTunnelArgs(4321, { mails: ["a@x.com", "*@example.co.jp"] });
    expect(args.slice(0, 3)).toEqual(["tunnel", "--url", "http://127.0.0.1:4321"]);
    expect(allowedMails(args)).toEqual(["*@example.co.jp", "a@x.com"]);
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
