import type { DiffUpdateState } from "../../server/src/core/index.ts";

export function LocalModeNotice({ local, diffUpdate }: { local: boolean; diffUpdate?: DiffUpdateState | null }) {
  if (!local) return null;
  const status = diffUpdate?.status;
  const suffix = status === "restarting" ? "・マップの更新を再開しています"
    : status === "stopped" ? "・マップの更新が止まっています" : "";
  return <>
    <div className="local-mode-line" data-status={status} aria-hidden="true" />
    <div className="local-mode-notice" data-status={status} role="status">ローカルモード・Apple Intelligence{suffix}</div>
  </>;
}
