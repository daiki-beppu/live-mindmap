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

const optionalNonEmpty = (name: string) => Config.String(name).pipe(Config.withDefault(""), Config.map((value) => (value.trim() === "" ? undefined : value.trim())));
export const cloudflareAccountIdConfig = optionalNonEmpty("CLOUDFLARE_ACCOUNT_ID");
export const cloudflareApiTokenConfig = optionalNonEmpty("CLOUDFLARE_API_TOKEN");

export const shareAllowConfig = Config.String("LIVE_MINDMAP_SHARE_ALLOW").pipe(
  Config.withDefault(""),
  Config.map((value) => value.split(",").map((item) => item.trim()).filter((item) => item !== "")),
);
