// 差分更新に添える共有画面の選び方。ライブ（callUpdater）と復元（replayDiff）が同じ関数を通す。
// 時刻はログの start と発言の end だけで測る（呼び出し時点の時計は使わない）。再生でも同じ選び方になる。

// 前に添えた画像から、次の画像を添えるまで空ける秒数。画像が短い間隔で変わり続けても、添える枚数を抑える
export const SCREEN_GAP_SECONDS = 10;

export type ScreenKey = { readonly start: number; readonly image: string | null };

// 候補を時刻順（安定ソート）に並べる
export const byStart = <T extends { readonly start: number }>(list: readonly T[]): T[] => [...list].sort((a, b) => a.start - b.start);

// 時刻順の候補から、この呼び出しに添えるものを選ぶ。
// - 共有の終了（image なし）は常に添え、10 秒の起点にしない
// - 画像は、直前に添えた画像の start から 10 秒以上離れていれば添える（同じ呼び出しの中でも、添えた画像を起点に順に判定する）
// - 10 秒未満の画像は添えない。持ち越し（carried）の画像だけは、cutoff（新しい発言の end の最大値）が起点 + 10 秒以上になった呼び出しで添える。
//   新しい変化が来なくても持ち越しを添えられるよう、start ではなく cutoff で判定する
export function selectScreens<T extends { readonly start: number; readonly image: string | null }>(
  sorted: readonly T[], carried: string | undefined, anchor: number | undefined, cutoff: number,
): T[] {
  const chosen: T[] = [];
  let a = anchor;
  for (const h of sorted) {
    if (h.image === null) {
      chosen.push(h);
    } else if (a === undefined || h.start >= a + SCREEN_GAP_SECONDS || (h.image === carried && cutoff >= a + SCREEN_GAP_SECONDS)) {
      chosen.push(h);
      a = h.start;
    }
  }
  return chosen;
}

// 持ち越すファイル名。候補の最新が、添えなかった画像のときだけ。途中の変化は捨てる
// （後の変化を添えた後に古い画像を送ると、映り続ける画面と食い違うので、最新より前は持ち越さない）
export function carriedOf(sorted: readonly ScreenKey[], attachedFiles: ReadonlySet<string>): string | undefined {
  const latest = sorted.at(-1);
  return latest?.image != null && !attachedFiles.has(latest.image) ? latest.image : undefined;
}

// 次の起点。添えた最後の画像の start。画像を添えなかったら前の値のまま
export function anchorAfter(attached: readonly ScreenKey[], previous: number | undefined): number | undefined {
  return attached.findLast((h) => h.image !== null)?.start ?? previous;
}
