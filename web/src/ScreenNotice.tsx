// 共有画面を使っていないことの一文（画面収録の許可が無いとき。Issue #280）。バッジや影は重ねない控えめな表示。
// 出す・消す（セッションにつき 1 回、届いてから約 10 秒）はサーバーが決める。ここは渡された文を描くだけの、hooks を持たない部品
export function ScreenNotice({ text }: { text: string | null }) {
  if (text === null) return null;
  return (
    <div className="screen-notice" aria-live="polite">
      {text}
    </div>
  );
}
