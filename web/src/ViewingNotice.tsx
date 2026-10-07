// 人が動かして自動のカメラを止めている間だけ、左下に控えめに出す文字（秒数・バッジ・影は出さない）。
export function ViewingNotice({ manual }: { manual: boolean }) {
  return manual ? <p className="viewing-notice">動かしています・議題が変わるか Esc で今の議題へ</p> : null;
}
