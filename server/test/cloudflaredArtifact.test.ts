import { describe, expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { resolveCloudflaredArtifact } from "../src/cloudflaredArtifact.ts";

describe("cloudflared の固定リリース", () => {
  it.effect.each([
    { arch: "arm64", asset: "cloudflared-darwin-arm64.tgz", sha256: "42af1e89acf6dac40cf5908ef5a42c166ce07da270b9e0149581be543ec6c6fb" },
    { arch: "x64", asset: "cloudflared-darwin-amd64.tgz", sha256: "165bbce902462e910d71b7eb16c1c03e29299a00b522f2c6938cd3f440d1b3ee" },
  ])("831 C2: darwin/$arch は指定された版・公式 URL・SHA256 を選ぶ", ({ arch, asset, sha256 }) => Effect.gen(function* () {
    expect(yield* resolveCloudflaredArtifact("darwin", arch)).toEqual({
      version: "2026.9.2",
      url: `https://github.com/cloudflare/cloudflared/releases/download/2026.9.2/${asset}`,
      sha256,
    });
  }));

  it.effect.each([
    { platform: "linux", arch: "arm64" },
    { platform: "win32", arch: "x64" },
    { platform: "darwin", arch: "ia32" },
  ])("831 C4: $platform/$arch は明確な理由で拒否する", ({ platform, arch }) => Effect.gen(function* () {
    const result = yield* Effect.result(resolveCloudflaredArtifact(platform, arch));
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure.message).toContain(platform);
      expect(result.failure.message).toContain(arch);
    }
  }));
});
