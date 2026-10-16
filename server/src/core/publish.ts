// cli publish の、Node に依存しない部分（Issue #1250）。置く HTML の head の差し替えと、置く Worker のスクリプト、期限の範囲。
// 会議名は URL・<title>・プレビュー用のメタのどこにも出さず、決まった文に差し替える。

export const PUBLISH_DEFAULT_DAYS = 7;
export const PUBLISH_MAX_DAYS = 30;
// Cloudflare の静的アセット 1 ファイルの上限
export const PUBLISH_MAX_ASSET_BYTES = 25 * 1024 * 1024;

import { Schema } from "effect";
import { escapeCell } from "./markdownTable.ts";
import { SEALED_SCRIPT_ID, unlockPageScript } from "./passphrase.ts";
import type { Sealed } from "./passphrase.ts";

export const PUBLISH_TITLE = "共有されたマインドマップ";
const PUBLISH_DESCRIPTION = "期限つきで共有されたマインドマップです";

// 検索・学習に使う主な AI クローラーの User-Agent（小文字の部分一致）。Discordbot・Twitterbot・Slackbot などのプレビュー用のボットは入れない
export const AI_CRAWLER_USER_AGENTS = [
  "gptbot", "chatgpt-user", "oai-searchbot", "claudebot", "claude-web", "anthropic-ai", "ccbot", "perplexitybot",
  "bytespider", "amazonbot", "applebot-extended", "meta-externalagent", "cohere-ai", "diffbot",
] as const;

const ROBOTS_TAG = "noindex, nofollow, noarchive, nosnippet";

const HEAD_OPEN = /<head(\s[^>]*)?>/i;
// 差し替える head のメタ（会議名が入りうるもの）
const TITLE_TAG = /<title[^>]*>[\s\S]*?<\/title>/gi;
const META_TAG = /<meta\s[^>]*?(?:name|property)\s*=\s*["']?(?:og:title|og:description|description|twitter:title|twitter:description)["']?[^>]*>/gi;

const FIXED_HEAD = `<title>${PUBLISH_TITLE}</title><meta property="og:title" content="${PUBLISH_TITLE}"><meta name="description" content="${PUBLISH_DESCRIPTION}"><meta property="og:description" content="${PUBLISH_DESCRIPTION}">`;

// head の <title> とプレビュー用のメタを、決まった文に差し替える。対象は <head> の開きから、最初の <script> か </head> までだけで、
// 埋め込んだログや JS の中の "<title>" という字面には触れない
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

// 合言葉で暗号化して置く外側のページ（Issue #1251）。合言葉の入力欄と暗号文と復号のスクリプトだけを持ち、会議に由来する文字は入れない。
// 暗号文は base64 なので、<script> の中に置いても "<" が出ない
export function lockedPublishPage(sealed: Sealed): string {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${FIXED_HEAD}</head>`
    + `<body><form><label>合言葉 <input type="text" autocomplete="off" autocapitalize="off" spellcheck="false" autofocus></label> <button type="submit">開く</button></form><p role="alert"></p>`
    + `<script type="application/json" id="${SEALED_SCRIPT_ID}">${JSON.stringify(sealed)}</script><script>${unlockPageScript()}</script></body></html>`;
}

// 置く Worker のスクリプト（module）。判定の順は 期限（410）→ /robots.txt → AI クローラー（403）→ asset。すべての応答に x-robots-tag を付ける。
// 期限のミリ秒はスクリプトに焼き込む
export function publishWorkerScript(expiresAtMs: number): string {
  return `const EXPIRES_AT = ${JSON.stringify(expiresAtMs)};
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
    if (Date.now() >= EXPIRES_AT) return respond("このリンクは期限が切れました\\n", { status: 410 });
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

// 公開の記録（~/.live-mindmap/publish/records.jsonl の 1 行）。状態は published（置き場にある）と withdrawn（取り下げた）の 2 つ
export const PublishRecord = Schema.Struct({
  name: Schema.String,
  url: Schema.String,
  accountId: Schema.String,
  // 元のセッションのフォルダ
  dir: Schema.String,
  // 中身の段。この段ではマップだけ
  level: Schema.Literal("map"),
  anyone: Schema.Boolean,
  // 合言葉つき（anyone: false）のときだけ入る
  passphrase: Schema.optionalKey(Schema.String),
  publishedAt: Schema.String,
  expiresAt: Schema.String,
  status: Schema.Literals(["published", "withdrawn"]),
});
export type PublishRecord = typeof PublishRecord.Type;

// cli publish list の対象。既定は公開中（期限が過ぎてもまだ消していない物を含む）だけ、all なら全部
export function selectListedRecords(records: ReadonlyArray<PublishRecord>, all: boolean): ReadonlyArray<PublishRecord> {
  return all ? records : records.filter((record) => record.status === "published");
}

const LEVEL_LABELS = { map: "マップだけ" } as const;

function statusLabel(record: PublishRecord, nowMs: number): string {
  if (record.status === "withdrawn") return "取り下げた";
  return Date.parse(record.expiresAt) <= nowMs ? "期限切れ（置き場に残っている）" : "公開中";
}

export function formatPublishList(records: ReadonlyArray<PublishRecord>, nowMs: number, all: boolean): string {
  if (records.length === 0) return all ? "公開の記録はありません\n" : "公開中の物はありません\n";
  const line = (cells: string[]) => `| ${cells.map(escapeCell).join(" | ")} |`;
  const header = ["URL", "合言葉", "期限", "中身の段", "元のセッション", "状態"];
  const rows = records.map((r) => [r.url, r.passphrase ?? "なし（--anyone）", r.expiresAt, LEVEL_LABELS[r.level], r.dir, statusLabel(r, nowMs)]);
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join("\n") + "\n";
}
