import { Result } from "effect";
import type { Effect } from "effect";
import type { PlaybackScreen } from "./core/index.ts";

export type SlideRow = {
  readonly start: number;
  readonly end: number;
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
