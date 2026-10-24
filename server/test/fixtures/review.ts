import { REVIEW_LOG_ELEMENT_ID } from "../../src/core/index.ts";

export const TEMPLATE = "<!doctype html><html><head></head><body><div id=\"root\"></div></body></html>";

export function embeddedText(html: string): string {
  const match = new RegExp(`<script type="application/json" id="${REVIEW_LOG_ELEMENT_ID}">([\\s\\S]*?)</script>`).exec(html);
  if (!match) throw new Error("埋め込みの要素がありません");
  return match[1]!;
}
