import type { DiffUpdateState } from "../../server/src/core/index.ts";

export function DiffUpdateNotice({ state }: { state: DiffUpdateState | null }) {
  if (state?.status !== "paused" || state.reason !== "ChatGPT の利用上限") return null;
  return <div className="diff-update-notice" role="status">マップの更新が止まっています（ChatGPT の利用上限）</div>;
}
