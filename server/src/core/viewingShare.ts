// 閲覧の共有の純粋な部分（Issue #834）。状態の型、cloudflared の出力からのホスト名の取り出し、cli の表示。
// 状態は 無し・共有中・切れた の 3 つ（切れたへの遷移は ViewingShare が行う）。
import { Schema } from "effect";

// メール（a@x.com）か、ドメイン全体（*@x.com）。空白・カンマ・複数の @ を含まない（cloudflared へカンマで連結しても曖昧にならない）
const SHARE_MAIL_RULE = "メールは a@example.com、ドメインは *@example.com の形で書く（空白とカンマは使えない）";
export const ShareMail = Schema.String.annotate({ message: SHARE_MAIL_RULE }).check(
  Schema.makeFilter((s) => /^[^\s,@]+@[^\s,@]+$/.test(s) || SHARE_MAIL_RULE),
);

// 許可の範囲。"anyone" は --anyone を明示したときだけ。それ以外は 1 件以上のメール・ドメイン
export const ShareAllow = Schema.Union([
  Schema.Literal("anyone"),
  Schema.Struct({ mails: Schema.Array(ShareMail).check(Schema.isMinLength(1)) }),
]);
export type ShareAllow = typeof ShareAllow.Type;

export const ShareStatus = Schema.Union([
  Schema.Struct({ status: Schema.Literal("off") }),
  Schema.Struct({ status: Schema.Literal("open"), url: Schema.NonEmptyString, allow: ShareAllow }),
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

// cloudflared の quick tunnel の引数。--allowed-mail はメール・ドメインがあるときだけ、カンマで連結して 1 回付ける
export function quickTunnelArgs(port: number, allow: ShareAllow): readonly string[] {
  const base = ["tunnel", "--url", `http://127.0.0.1:${port}`];
  return allow === "anyone" ? base : [...base, "--allowed-mail", allow.mails.join(",")];
}

// cli status の閲覧の共有の行（取り込みの行の後ろに続ける）
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

// cli share の標準出力。URL・許可の範囲・稼働の保証が無い旨
export function formatShareOpened(status: Extract<ShareStatus, { status: "open" }>): string {
  return [
    `閲覧の共有を開きました: ${status.url}`,
    `許可の範囲: ${formatAllow(status.allow)}`,
    "この URL の稼働は保証しません。切れることがあります",
  ].join("\n") + "\n";
}

// POST /share/open が、新しく開いたか、すでに開いていた共有の状態を返したかを伝える応答ヘッダー。
// 判定は ViewingShare.open のロックの中で一度だけ行い、本文（状態）の形は変えない
export const SHARE_OPEN_OUTCOME_HEADER = "x-share-open-outcome";
export const ShareOpenOutcome = Schema.Literals(["opened", "already-open"]);
export type ShareOpenOutcome = typeof ShareOpenOutcome.Type;

// cli share がすでに共有中のときの標準エラー（1 行）。新しくは開かず、今の URL と許可の範囲を示す
export function formatShareAlreadyOpen(status: Extract<ShareStatus, { status: "open" }>): string {
  return `すでに閲覧の共有を開いています（新しくは開きません）。URL: ${status.url} 許可の範囲: ${formatAllow(status.allow)}\n`;
}
