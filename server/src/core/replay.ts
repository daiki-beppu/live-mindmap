import type { Session, Utterance } from "./session.ts";

// 発言の流れを待ち時間なしで流す。1 つ流すたびに呼び出しの終わりを待つので、
// 呼び出しの区切りは応答の速さによらず、呼び出しが重ならないライブと同じになる。
export async function replay(session: Session, utterances: Iterable<Utterance>): Promise<void> {
  for (const u of utterances) {
    session.push(u);
    await session.idle();
  }
  await session.flush();
}
