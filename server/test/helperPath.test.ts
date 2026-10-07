import { describe, expect, it } from "vitest";
import { DEFAULT_HELPER_PATH, HELPER_BUILD_COMMAND, resolveHelperPath } from "../src/helperPath.ts";

describe("resolveHelperPath", () => {
  it("既定は最適化ありのビルド（release）の実行ファイル", () => {
    expect(DEFAULT_HELPER_PATH).toMatch(/helper\/\.build\/release\/live-mindmap-helper$/);
    expect(resolveHelperPath({}, () => true)).toEqual({ path: DEFAULT_HELPER_PATH });
  });

  it("LIVE_MINDMAP_HELPER を指定したときは、その実行ファイルを使う（既定の有無を見ない）", () => {
    const exists = () => false;
    expect(resolveHelperPath({ LIVE_MINDMAP_HELPER: "/tmp/fake-helper" }, exists)).toEqual({ path: "/tmp/fake-helper" });
  });

  it("既定の実行ファイルが無ければ、debug に戻らず、ビルドのコマンドを示して失敗する", () => {
    const result = resolveHelperPath({}, () => false);
    expect(result).not.toHaveProperty("path");
    expect("error" in result && result.error).toContain(HELPER_BUILD_COMMAND);
  });
});
