import { REVIEW_LOG_ELEMENT_ID } from "../../src/core/index.ts";

export const TEMPLATE = "<!doctype html><html><head></head><body><div id=\"root\"></div></body></html>";

// 埋め込んだ JSON 要素の中身を取り出す（ブラウザの textContent と同じく、タグの間の文字列そのもの）
export function embeddedText(html: string): string {
  const match = new RegExp(`<script type="application/json" id="${REVIEW_LOG_ELEMENT_ID}">([\\s\\S]*?)</script>`).exec(html);
  if (!match) throw new Error("埋め込みの要素がありません");
  return match[1]!;
}
