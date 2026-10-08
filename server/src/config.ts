// 常駐サーバー（server.ts）と CLI（cli.ts）が共有する環境変数の設定。ポートとセッションのフォルダの読み方と既定値はここだけが持つ。
// 設定は呼び出し側の Effect の先頭で 1 回だけ解決する（下位の処理は process.env を読み直さない）。
import { homedir } from "node:os";
import { join } from "node:path";
import { Config } from "effect";

const DEFAULT_PORT = 4319;

export const sessionsDirConfig = Config.String("LIVE_MINDMAP_SESSIONS").pipe(
  Config.withDefault(join(homedir(), ".live-mindmap", "sessions")),
);
// ポートは Config.Int（Config.Port は 1 以上しか受けず、空きポートを選ばせる 0 を拒む）
export const portConfig = Config.Int("LIVE_MINDMAP_PORT").pipe(Config.withDefault(DEFAULT_PORT));
