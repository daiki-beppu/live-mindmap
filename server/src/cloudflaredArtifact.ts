import { Effect, Schema, type Cause } from "effect";

export const CLOUDFLARED_VERSION = "2026.9.2";
export type CloudflaredArtifact = {
  readonly version: string;
  readonly url: string;
  readonly sha256: string;
};
export type CloudflaredSource = {
  readonly resolve: Effect.Effect<CloudflaredArtifact, Cause.YieldableError>;
  readonly download: (url: string, destination: string) => Effect.Effect<void, Cause.YieldableError>;
};

class UnsupportedCloudflaredPlatform extends Schema.TaggedError<UnsupportedCloudflaredPlatform>()("UnsupportedCloudflaredPlatform", {
  message: Schema.String,
}) {}

export const resolveCloudflaredArtifact = Effect.fnUntraced(function* (platform: string, arch: string) {
  if (platform !== "darwin" || (arch !== "arm64" && arch !== "x64")) {
    return yield* new UnsupportedCloudflaredPlatform({ message: `cloudflared は未対応の環境です: ${platform}/${arch}（macOS arm64/x64 のみ）` });
  }
  const asset = arch === "arm64" ? "cloudflared-darwin-arm64.tgz" : "cloudflared-darwin-amd64.tgz";
  return {
    version: CLOUDFLARED_VERSION,
    url: `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${asset}`,
    sha256: arch === "arm64"
      ? "42af1e89acf6dac40cf5908ef5a42c166ce07da270b9e0149581be543ec6c6fb"
      : "165bbce902462e910d71b7eb16c1c03e29299a00b522f2c6938cd3f440d1b3ee",
  };
});
