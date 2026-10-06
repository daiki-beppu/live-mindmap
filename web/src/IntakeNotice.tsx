// 字幕（Captions）の横に出す、取り込みの状態の一言（order.md「画面」）。バッジや影は重ねない控えめな表示。
// 文そのものの規則は intake.ts（useIntakeNotice.ts が React の糊）。ここは hooks を持たない Passive View の部品
export function IntakeNotice({ text }: { text: string | null }) {
  if (text === null) return null;
  return (
    <div className="intake-notice" aria-live="polite">
      {text}
    </div>
  );
}
