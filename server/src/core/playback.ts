import type { Remark, Session } from "./session.ts";

// 再生: 発言の流れを待ち時間なしで流す。1 つ流すたびに呼び出しの終わりを待つので、
// 呼び出しの区切りは応答の速さによらず、呼び出しが重ならないライブと同じになる。
// そのため「呼び出し中にたまった発言をまとめる」経路は再生では通らない（セッションのテストで確かめる）。
export async function playback(session: Session, remarks: Iterable<Remark>): Promise<void> {
  for (const r of remarks) {
    session.push(r);
    await session.idle();
  }
  await session.flush();
}
