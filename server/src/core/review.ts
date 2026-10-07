// 見返し用の HTML（map.html）の、Node に依存しない部分。サーバー（書き出し）とブラウザ（表示）の両方が読む。
import { restoreSession, type Snapshot } from "./session.ts";

// ログ（log.jsonl の出来事）を埋め込む <script type="application/json"> の id
export const REVIEW_LOG_ELEMENT_ID = "live-mindmap-review-log";

const BODY_END = "</body>";

// テンプレート HTML の最後の </body> の直前に、出来事を JSON 要素として差し込む。
// `<` は < にして、発言の中の </script> や <!-- で要素が閉じたり壊れたりしないようにする。
// インライン化した JS の中に "</body>" があっても壊れないよう、最後の </body> を使う
export function embedReviewLog(html: string, events: readonly unknown[]): string {
  const at = html.lastIndexOf(BODY_END);
  if (at < 0) throw new Error("テンプレートに </body> がありません");
  const json = JSON.stringify(events).replaceAll("<", "\\u003c");
  const element = `<script type="application/json" id="${REVIEW_LOG_ELEMENT_ID}">${json}</script>`;
  return html.slice(0, at) + element + html.slice(at);
}

// ログの出来事から、最後の時点のスナップショットを組み立てる。差分更新は呼ばない
export function reviewSnapshot(events: readonly unknown[]): Snapshot {
  return restoreSession(events, {
    updater: async () => {
      throw new Error("見返しでは差分更新を呼べません");
    },
    log: () => {},
  }).snapshot();
}
