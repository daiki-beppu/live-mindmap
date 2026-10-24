import { Schema } from "effect";

// メール（a@x.com）か、ドメイン全体（*@x.com）。空白・カンマ・複数の @ を含まない（cloudflared へカンマで連結しても曖昧にならない）
const SHARE_MAIL_RULE = "メールは a@example.com、ドメインは *@example.com の形で書く（空白とカンマは使えない）";
export const ShareMail = Schema.String.annotate({ message: SHARE_MAIL_RULE }).check(
  Schema.makeFilter((s) => /^[^\s,@]+@[^\s,@]+$/.test(s) || SHARE_MAIL_RULE),
);

export const ShareAllow = Schema.Union([
  Schema.Literal("anyone"),
  Schema.Struct({ mails: Schema.Array(ShareMail).check(Schema.isMinLength(1)) }),
]);
export type ShareAllow = typeof ShareAllow.Type;

export const OpenShareStatus = Schema.Struct({ status: Schema.Literal("open"), url: Schema.NonEmptyString, allow: ShareAllow });

export const ShareStatus = Schema.Union([
  Schema.Struct({ status: Schema.Literal("off") }),
  OpenShareStatus,
  Schema.Struct({ status: Schema.Literal("broken"), allow: ShareAllow }),
]);
export type ShareStatus = typeof ShareStatus.Type;

// quick tunnel の公開のホスト名（ハイフンを含むラベル）。api.trycloudflare.com はラベルにハイフンが無いので当たらない
const QUICK_TUNNEL_URL = /https:\/\/([a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com)(?![a-z0-9.-])/i;

export function quickTunnelHostname(text: string): string | undefined {
  return QUICK_TUNNEL_URL.exec(text)?.[1];
}

function formatAllow(allow: ShareAllow): string {
  return allow === "anyone" ? "誰でも" : allow.mails.join(", ");
}

export function quickTunnelArgs(port: number, allow: ShareAllow): readonly string[] {
  const base = ["tunnel", "--url", `http://127.0.0.1:${port}`];
  return allow === "anyone" ? base : [...base, "--allowed-mail", allow.mails.join(",")];
}

export function formatShareStatus(status: ShareStatus): string {
  switch (status.status) {
    case "off":
      return "閲覧の共有: 無し\n";
    case "open":
      return [`閲覧の共有: 共有中`, `URL: ${status.url}`, `許可の範囲: ${formatAllow(status.allow)}`].join("\n") + "\n";
    case "broken":
      return [`閲覧の共有: 切れた`, `許可の範囲: ${formatAllow(status.allow)}`].join("\n") + "\n";
  }
}

export function formatShareOpened(status: Extract<ShareStatus, { status: "open" }>): string {
  return [
    `閲覧の共有を開きました: ${status.url}`,
    `許可の範囲: ${formatAllow(status.allow)}`,
    "この URL の稼働は保証しません。切れることがあります",
  ].join("\n") + "\n";
}

export const SHARE_OPEN_OUTCOME_HEADER = "x-share-open-outcome";
export const ShareOpenOutcome = Schema.Literals(["opened", "already-open"]);
export type ShareOpenOutcome = typeof ShareOpenOutcome.Type;

export function formatShareAlreadyOpen(status: Extract<ShareStatus, { status: "open" }>): string {
  return `すでに閲覧の共有を開いています（新しくは開きません）。URL: ${status.url} 許可の範囲: ${formatAllow(status.allow)}\n`;
}
