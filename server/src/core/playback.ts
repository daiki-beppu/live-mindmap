import type { Remark, Session } from "./session.ts";

export type PlaybackOptions = {
  // 渡すと等速: 発言の end の差だけ待ってから流す（最初は 0 からの差）。待ち方は呼び出し側が決める。
  sleep?: (ms: number) => Promise<void>;
};

// 再生: 発言の流れを流す。
// 待ち時間なし（sleep なし）: 1 つ流すたびに呼び出しの終わりを待つので、呼び出しの区切りは応答の速さによらず、
//   呼び出しが重ならないライブと同じになる。そのため「呼び出し中にたまった発言をまとめる」経路は
//   再生では通らない（セッションのテストで確かめる）。
// 等速（sleep あり）: 呼び出しの終わりは待たず、ライブと同じ呼び出し方で流す。
export async function playback(session: Session, remarks: Iterable<Remark>, { sleep }: PlaybackOptions = {}): Promise<void> {
  let prevEnd = 0;
  for (const r of remarks) {
    if (sleep) {
      await sleep((r.end - prevEnd) * 1000);
      prevEnd = r.end;
    }
    session.push(r);
    if (!sleep) await session.idle();
  }
  await session.flush();
}
