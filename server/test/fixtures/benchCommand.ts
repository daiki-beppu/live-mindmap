const remarkLine = (track: "相手" | "自分", start: number, end: number) => JSON.stringify({ type: "remark", remark: { id: "r", track, start, end, text: "本文" } });

// sessionStats の Command に渡す log.jsonl の中身
export const logText = [JSON.stringify({ type: "start", title: "t" }), remarkLine("相手", 0, 4), remarkLine("自分", 2, 6), JSON.stringify({ type: "diff", ops: [{}], dropped: [] })].join("\n") + "\n";
