// 自動のカメラを止めている間だけ、左下に控えめに出す文字（秒数・バッジ・影は出さない）。
// manual は人が動かしているとき、overview は全体を見ているとき。
export function ViewingNotice({ manual, overview = false }: { manual: boolean; overview?: boolean }) {
  if (overview) return <p className="viewing-notice">全体を見ています・F か Esc で戻る・? でキー一覧</p>;
  return manual ? <p className="viewing-notice">動かしています・議題が変わるか Esc で今の議題へ・? でキー一覧</p> : null;
}
