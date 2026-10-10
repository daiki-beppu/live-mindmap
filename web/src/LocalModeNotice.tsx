export function LocalModeNotice({ local }: { local: boolean }) {
  if (!local) return null;
  return <>
    <div className="local-mode-line" aria-hidden="true" />
    <div className="local-mode-notice">ローカルモード・Apple Intelligence</div>
  </>;
}
