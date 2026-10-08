import { Effect } from "effect";
import type { Remark, ScreenOffEvent, Session } from "./session.ts";

// 共有画面の変化。image は、画像のバイト列を入れる直前に作るもの（再生が終わるまで全画像のバイト列を持たないための形）。
// reason を持つものは screen-off（共有画面を見ていない印）で、元の start・reason のまま入れる
export type PlaybackScreen<E> =
  | {
      readonly start: number;
      readonly image: { readonly id: string; readonly load: Effect.Effect<Uint8Array, E> } | null;
    }
  | { readonly start: number; readonly reason: (typeof ScreenOffEvent)["Type"]["reason"] };

export type PlaybackOptions<E> = {
  // 渡すと等速: 発言の end まで待ってから流す（最初は 0 からの差）。待ち方は呼び出し側が決める。
  // 共有画面の変化も同じ時計で、変化の start まで待ってから入れる。
  // 発言も変化も、すでに過ぎた時刻は待たず、時計も戻さない
  sleep?: (ms: number) => Effect.Effect<void>;
  // 共有画面の変化。発言を入れる前に、その発言の start までに映り始めた変化をすべて入れる（入れた後は idle を待たない）。
  // 残りは最後の発言の後、flush の前に入れる。待ち時間なしでは変化の時刻を待たない
  screens?: Iterable<PlaybackScreen<E>>;
};

// 再生: 発言の流れを流す。
// 待ち時間なし（sleep なし）: 1 つ流すたびに呼び出しの終わりを待つので、呼び出しの区切りは応答の速さによらず、
//   呼び出しが重ならないライブと同じになる。そのため「呼び出し中にたまった発言をまとめる」経路は
//   再生では通らない（セッションのテストで確かめる）。
// 等速（sleep あり）: 呼び出しの終わりは待たず、ライブと同じ呼び出し方で流す。
export const playback = <E = never>(
  session: Session,
  remarks: Iterable<Remark>,
  { sleep, screens }: PlaybackOptions<E> = {},
): Effect.Effect<void, E> =>
  Effect.gen(function* () {
    // 等速の「今の時刻」。発言と変化で共有する
    let now = 0;
    // 時刻 t まで待つ。すでに過ぎた時刻は待たず、時計も戻さない
    const waitUntil = Effect.fnUntraced(function* (t: number) {
      if (sleep && t > now) {
        yield* sleep((t - now) * 1000);
        now = t;
      }
    });
    const waiting = [...(screens ?? [])].sort((a, b) => a.start - b.start);
    let next = 0;
    // 入れる直前に画像を作る。作ったバイト列は pushScreen に渡したら持たない
    const pushNext = Effect.gen(function* () {
      const change = waiting[next++]!;
      yield* waitUntil(change.start);
      if ("reason" in change) {
        yield* session.pushScreenOff({ start: change.start, reason: change.reason });
        return;
      }
      const { start, image } = change;
      yield* session.pushScreen({ start, image: image === null ? null : { id: image.id, bytes: yield* image.load } });
    });
    for (const r of remarks) {
      while (next < waiting.length && waiting[next]!.start <= r.start) yield* pushNext;
      yield* waitUntil(r.end);
      yield* session.push(r);
      if (!sleep) yield* session.idle;
    }
    while (next < waiting.length) yield* pushNext;
    yield* session.flush;
  });
