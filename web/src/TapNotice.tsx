// 相手の音声が届いていないことの一文（helper の tap-silent。Issue #863）。バッジや影は重ねない控えめな表示。
// 出す・消す（新しい origin かセッションの終わりまで出し続ける）はサーバーが決める。ここは渡された文を描くだけの、hooks を持たない部品
export function TapNotice({ text }: { text: string | null }) {
  if (text === null) return null;
  return (
    <div className="tap-notice" aria-live="polite">
      {text}
    </div>
  );
}
