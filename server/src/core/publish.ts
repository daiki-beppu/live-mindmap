import { Schema } from "effect";
import { escapeCell } from "./markdownTable.ts";
import { SEALED_SCRIPT_ID, unlockPageScript } from "./passphrase.ts";
import type { Sealed } from "./passphrase.ts";

export const PUBLISH_DEFAULT_DAYS = 7;
export const PUBLISH_MAX_DAYS = 30;
// Cloudflare の静的アセット 1 ファイルの上限
export const PUBLISH_MAX_ASSET_BYTES = 25 * 1024 * 1024;

export const PUBLISH_CONTENTS = ["map", "remarks", "audio"] as const;
export type PublishContent = (typeof PUBLISH_CONTENTS)[number];

export function publishConfirmationMessage(input: { readonly content: "remarks" | "audio"; readonly anyone: boolean }): string {
  return [
    `${input.content === "audio" ? "発言の文字と録音" : "発言の文字"}を含む公開は、利用者に確かめるまで置きません（何も送っていません）`,
    "利用者に、閉じた会議なら相手の了解を、イベントなら規約と登壇者の許可を確かめたかを聞いてください",
    "了解を得たら、--confirmed を付けて実行し直してください",
    ...(input.content === "audio" ? ["録音について: 声は話し手を特定できれば個人情報にもなる"] : []),
    ...(input.anyone ? ["--anyone について: URL を知る誰でも見られる＝公衆への送信に当たる"] : []),
  ].join("\n");
}

export const PUBLISH_TITLE = "共有されたマインドマップ";
const PUBLISH_DESCRIPTION = "期限つきで共有されたマインドマップです";

export const AI_CRAWLER_USER_AGENTS = [
  "gptbot", "chatgpt-user", "oai-searchbot", "claudebot", "claude-web", "anthropic-ai", "ccbot", "perplexitybot",
  "bytespider", "amazonbot", "applebot-extended", "meta-externalagent", "cohere-ai", "diffbot",
] as const;

const ROBOTS_TAG = "noindex, nofollow, noarchive, nosnippet";

const HEAD_OPEN = /<head(\s[^>]*)?>/i;
const TITLE_TAG = /<title[^>]*>[\s\S]*?<\/title>/gi;
const META_TAG = /<meta\s[^>]*?(?:name|property)\s*=\s*["']?(?:og:title|og:description|description|twitter:title|twitter:description)["']?[^>]*>/gi;

const FIXED_HEAD = `<title>${PUBLISH_TITLE}</title><meta property="og:title" content="${PUBLISH_TITLE}"><meta name="description" content="${PUBLISH_DESCRIPTION}"><meta property="og:description" content="${PUBLISH_DESCRIPTION}">`;

export function replaceHeadForPublish(html: string): string {
  const open = HEAD_OPEN.exec(html);
  if (open === null) throw new Error("テンプレートに <head> がありません");
  const start = open.index + open[0].length;
  const scriptAt = html.indexOf("<script", start);
  const closeAt = html.indexOf("</head>", start);
  const candidates = [scriptAt, closeAt].filter((at) => at >= 0);
  if (candidates.length === 0) throw new Error("テンプレートに </head> がありません");
  const end = Math.min(...candidates);
  const kept = html.slice(start, end).replace(TITLE_TAG, "").replace(META_TAG, "");
  return html.slice(0, start) + FIXED_HEAD + kept + html.slice(end);
}

export function lockedPublishPage(sealed: Sealed): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${FIXED_HEAD}</head>`
    + `<body><form><label>合言葉 <input type="text" autocomplete="off" autocapitalize="off" spellcheck="false" autofocus></label> <button type="submit">開く</button></form><p role="alert"></p>`
    + `<script type="application/json" id="${SEALED_SCRIPT_ID}">${JSON.stringify(sealed).replaceAll("<", "\\u003c")}</script><script>${unlockPageScript()}</script></body></html>`;
}

// 文面を toString() で Worker に埋め込むので、外の名前を参照しない
const isPastExpiryAt = (expiresAtMs: number, nowMs: number): boolean => expiresAtMs <= nowMs;

export function publishWorkerScript(expiresAtMs: number): string {
  return `const EXPIRES_AT = ${JSON.stringify(expiresAtMs)};
const isPastExpiryAt = ${isPastExpiryAt.toString()};
const AI_CRAWLERS = ${JSON.stringify(AI_CRAWLER_USER_AGENTS)};
const ROBOTS_TAG = ${JSON.stringify(ROBOTS_TAG)};

const respond = (body, init) => {
  const headers = new Headers(init.headers);
  headers.set("x-robots-tag", ROBOTS_TAG);
  headers.set("content-type", "text/plain; charset=utf-8");
  return new Response(body, { status: init.status, headers });
};

export default {
  async fetch(request, env) {
    if (isPastExpiryAt(EXPIRES_AT, Date.now())) return respond("このリンクは期限が切れました\\n", { status: 410 });
    const url = new URL(request.url);
    if (url.pathname === "/robots.txt") return respond("User-agent: *\\nDisallow: /\\n", { status: 200 });
    const userAgent = (request.headers.get("user-agent") ?? "").toLowerCase();
    if (AI_CRAWLERS.some((crawler) => userAgent.includes(crawler))) return respond("Forbidden\\n", { status: 403 });
    const asset = await env.ASSETS.fetch(request);
    const headers = new Headers(asset.headers);
    headers.set("x-robots-tag", ROBOTS_TAG);
    return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
  },
};
`;
}

export const PublishRecord = Schema.Struct({
  name: Schema.String,
  url: Schema.String,
  accountId: Schema.String,
  dir: Schema.String,
  level: Schema.Literals(PUBLISH_CONTENTS),
  anyone: Schema.Boolean,
  passphrase: Schema.optionalKey(Schema.String),
  publishedAt: Schema.String,
  expiresAt: Schema.String,
  status: Schema.Literals(["published", "withdrawn", "expired"]),
});
export type PublishRecord = typeof PublishRecord.Type;

export function selectListedRecords(records: ReadonlyArray<PublishRecord>, all: boolean): ReadonlyArray<PublishRecord> {
  return all ? records : records.filter((record) => record.status === "published");
}

const LEVEL_LABELS = { map: "マップだけ", remarks: "発言の文字も", audio: "録音も" } as const satisfies Record<PublishContent, string>;

export function expiredPublishedRecords(records: ReadonlyArray<PublishRecord>, nowMs: number): ReadonlyArray<PublishRecord> {
  return records.filter((record) => record.status === "published" && isPastExpiryAt(Date.parse(record.expiresAt), nowMs));
}

function statusLabel(record: PublishRecord, nowMs: number): string {
  if (record.status === "withdrawn") return "取り下げた";
  if (record.status === "expired") return "期限切れで消した";
  return isPastExpiryAt(Date.parse(record.expiresAt), nowMs) ? "期限切れ（置き場に残っている）" : "公開中";
}

export function formatPublishList(records: ReadonlyArray<PublishRecord>, nowMs: number, all: boolean): string {
  if (records.length === 0) return all ? "公開の記録はありません\n" : "公開中の物はありません\n";
  const line = (cells: string[]) => `| ${cells.map(escapeCell).join(" | ")} |`;
  const header = ["URL", "合言葉", "期限", "中身の段", "元のセッション", "状態"];
  const rows = records.map((r) => [r.url, r.passphrase ?? "なし（--anyone）", r.expiresAt, LEVEL_LABELS[r.level], r.dir, statusLabel(r, nowMs)]);
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join("\n") + "\n";
}
