// 共有画面の一覧 slides.tsv（start end slide image）を読む。1 行目は見出しで読み飛ばす。
// image は tsv のあるフォルダからの相対パス。画像の変換とファイル読み込みはここではしない
import { Result } from "effect";
import type { Effect } from "effect";
import type { PlaybackScreen } from "./core/index.ts";

export type SlideRow = {
  readonly start: number; // 映り始めた会議の秒
  readonly end: number; // 映り終わった会議の秒
  readonly slide: string;
  readonly image: string;
};

const toSeconds = (cell: string): number | undefined => {
  const text = cell.trim();
  const n = Number(text);
  return text !== "" && Number.isFinite(n) ? n : undefined;
};

export function parseSlides(text: string): Result.Result<SlideRow[], string> {
  const rows: SlideRow[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "") continue;
    const cells = line.split("\t");
    if (cells.length < 4) return Result.fail(`${i + 1} 行目の列が足りません（start end slide image の 4 列）`);
    const start = toSeconds(cells[0]!);
    const end = toSeconds(cells[1]!);
    if (start === undefined || end === undefined) return Result.fail(`${i + 1} 行目の start か end が数値ではありません`);
    const image = cells[3]!.trim();
    if (image === "") return Result.fail(`${i + 1} 行目の image が空です`);
    rows.push({ start, end, slide: cells[2]!.trim(), image });
  }
  return Result.succeed(rows);
}

// 行番号から、その行の変換済み画像を読む Effect を受け取り、共有画面の変化の列を作る（画像は再生が入れる直前に読む）。
// 行の start に画像の変化を、end に「なし」の変化を入れる。ただし次の行が end ちょうど（以前）に始まるなら、その end には入れない。
// gallery（顔だけ）の行も、ほかの行と同じく画像の変化にする
export function slideChanges<E>(rows: readonly SlideRow[], loadImage: (index: number) => Effect.Effect<Uint8Array, E>): PlaybackScreen<E>[] {
  return rows.flatMap((row, i): PlaybackScreen<E>[] => {
    const next = rows[i + 1];
    const gap = next === undefined || next.start > row.end;
    return [
      { start: row.start, image: { id: row.image, load: loadImage(i) } },
      ...(gap ? [{ start: row.end, image: null }] : []),
    ];
  });
}
