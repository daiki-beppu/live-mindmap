import type { Op } from "./map.ts";
import { earliestRemark, type Remark } from "./remark.ts";

const speakerOf = (r: Remark): string => r.speaker ?? r.track;

export function attributePeople(ops: readonly Op[], remarks: ReadonlyMap<string, Remark>): Op[] {
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
