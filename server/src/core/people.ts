// 案の出した人と TODO の担当の話者（Issue #1023）。AI の出した操作に、サーバーが決める人の欄を足し、検査を通らない欄を外す。
// 出した人は add の根拠のうち最も早い発言の話者（AI は書かない）。担当の話者は、セッションにいる話者だけを残す。
import type { Op } from "./map.ts";
import { earliestRemark, type Remark } from "./remark.ts";

// 発言の話者。remarkLine.ts と同じ規則（話者のラベル、無ければトラック）
const speakerOf = (r: Remark): string => r.speaker ?? r.track;

export function attributePeople(ops: readonly Op[], remarks: ReadonlyMap<string, Remark>): Op[] {
  // セッションにいる話者: 「自分」と、発言に付いた話者のラベル
  const inSession = new Set<string>(["自分"]);
  for (const r of remarks.values()) if (r.speaker !== undefined) inSession.add(r.speaker);
  const checked = (speaker: string | undefined) => (speaker !== undefined && inSession.has(speaker) ? { assigneeSpeaker: speaker } : {});

  return ops.map((op): Op => {
    if (op.op === "add") {
      const { assigneeSpeaker, proposer: _ignored, ...rest } = op;
      const first = op.kind === "案" ? earliestRemark(op.evidence, remarks) : undefined;
      return { ...rest, ...(first ? { proposer: speakerOf(first) } : {}), ...checked(assigneeSpeaker) };
    }
    if (op.op === "update") {
      const { assigneeSpeaker, ...rest } = op;
      return { ...rest, ...checked(assigneeSpeaker) };
    }
    return op;
  });
}
