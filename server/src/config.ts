// 常駐サーバー（server.ts）と CLI（cli.ts）が共有する環境変数の設定。ポートとセッションのフォルダの読み方と既定値はここだけが持つ。
// 設定は呼び出し側の Effect の先頭で 1 回だけ解決する（下位の処理は process.env を読み直さない）。
import { homedir } from "node:os";
import { join } from "node:path";
import { Config } from "effect";

const DEFAULT_PORT = 4319;

export const depsDirConfig = Config.String("LIVE_MINDMAP_DEPS").pipe(
  Config.withDefault(join(homedir(), ".live-mindmap", "deps")),
);

export const sessionsDirConfig = Config.String("LIVE_MINDMAP_SESSIONS").pipe(
  Config.withDefault(join(homedir(), ".live-mindmap", "sessions")),
);
// ポートは Config.Int（Config.Port は 1 以上しか受けず、空きポートを選ばせる 0 を拒む）
export const portConfig = Config.Int("LIVE_MINDMAP_PORT").pipe(Config.withDefault(DEFAULT_PORT));

// cli publish が使う Cloudflare の資格情報。無い・空は undefined（案内の文は cli が持つ）
const optionalNonEmpty = (name: string) => Config.String(name).pipe(Config.withDefault(""), Config.map((value) => (value.trim() === "" ? undefined : value.trim())));
export const cloudflareAccountIdConfig = optionalNonEmpty("CLOUDFLARE_ACCOUNT_ID");
export const cloudflareApiTokenConfig = optionalNonEmpty("CLOUDFLARE_API_TOKEN");

// 閲覧の共有の既定の許可（メール・ドメイン）。カンマ区切りで、前後の空白と空の要素は捨てる。無ければ空
export const shareAllowConfig = Config.String("LIVE_MINDMAP_SHARE_ALLOW").pipe(
  Config.withDefault(""),
  Config.map((value) => value.split(",").map((item) => item.trim()).filter((item) => item !== "")),
);
