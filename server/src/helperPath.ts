// ヘルパーの実行ファイルの場所。会議で使うので、最適化ありのビルド（release）を既定にする（issue #233）。
// 最適化なし（debug）は CPU を 5 倍ほど使い、負荷の高い Mac では入力の滞留で数分おきに止まった
import { existsSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_HELPER_PATH = join(import.meta.dirname, "../../helper/.build/release/live-mindmap-helper");
export const HELPER_BUILD_COMMAND = "swift build -c release --package-path helper";

// LIVE_MINDMAP_HELPER があればそれを使う。既定の実行ファイルが無いときは debug に黙って戻らず、ビルドのコマンドを示して失敗する
export function resolveHelperPath(
  env: Readonly<Record<string, string | undefined>>,
  exists: (path: string) => boolean = existsSync,
): { readonly path: string } | { readonly error: string } {
  if (env.LIVE_MINDMAP_HELPER) return { path: env.LIVE_MINDMAP_HELPER };
  if (exists(DEFAULT_HELPER_PATH)) return { path: DEFAULT_HELPER_PATH };
  return {
    error: `ヘルパーの実行ファイルがありません: ${DEFAULT_HELPER_PATH}\n`
      + `リポジトリのルートで \`${HELPER_BUILD_COMMAND}\` を実行してビルドするか、LIVE_MINDMAP_HELPER で実行ファイルを指定してください`,
  };
}
