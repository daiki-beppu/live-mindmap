// PROTOTYPE — System One モデル（Jev / OpenAI Decisions）による前段ゲート。
// 発言が届くたびに型付きの質問を投げ、Claude を今呼ぶかを決める。文章は生成させない。
import { children, issueStatus, ROOT, type MindMap, type Segment } from "./map";

// ゲートが毎回答える質問への答え。確率は 0〜1。
export type GateAnswers = {
  mapWorthy: number; // この発言にマップへ載せるべき中身（議題・論点・案・決定・課題・TODO）があるか
  topicShift: number; // 直前までと話題が切り替わったか
  target: string; // 最も関係する既存ノードの id。"new" は新しい話題、"none" は中身なし
  targetConfidence: number;
  latencyMs: number;
  usage: { input: number; output: number };
};

export interface Gate {
  name: string;
  ask(map: MindMap, recent: Segment[], seg: Segment): Promise<GateAnswers>;
}

// choice の選択肢にする既存ノード（上限 255 なので、会議 60 分なら全ノードが収まる想定）
function nodeCriteria(map: MindMap): Record<string, string> {
  const c: Record<string, string> = {};
  for (const id of map.order) {
    if (id === ROOT) continue;
    const n = map.nodes[id]!;
    const status = n.kind === "論点" ? `(${issueStatus(map, id)})` : "";
    c[id] = `${n.kind}${status}: ${n.text}`;
    if (Object.keys(c).length >= 250) break;
  }
  c.new = "既存のどのノードにも当てはまらない新しい話題";
  c.none = "会議の中身ではない（挨拶・進行・相づち・雑談・解説）";
  return c;
}

export class JevGate implements Gate {
  name = "jev";
  constructor(private apiKey = process.env.TYPESAFE_API_KEY) {
    if (!apiKey) throw new Error("TYPESAFE_API_KEY が無い。bun run run -- ... で起動する（op run が .env.op を解決する）");
  }
  async ask(map: MindMap, recent: Segment[], seg: Segment): Promise<GateAnswers> {
    const t0 = Date.now();
    const state = [
      "# 直前の発言", ...recent.map((s) => s.text),
      "# 新しい発言", seg.text,
    ].join("\n");
    const res = await fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "jev-latest",
        state,
        questions: {
          map_worthy: {
            type: "noul",
            instructions: "会議のマインドマップに載せるべき中身（議題・論点・案・決定・課題・TODO）が、新しい発言に含まれているか",
            criteria: { true: "会議の中身を述べている", false: "挨拶・進行・相づち・雑談・解説だけ" },
          },
          topic_shift: {
            type: "noul",
            instructions: "新しい発言で、直前の発言から話題が切り替わったか",
            criteria: { true: "別の話題に移った", false: "同じ話題が続いている" },
          },
          target: {
            type: "choice",
            instructions: "新しい発言は、マインドマップのどのノードに最も関係するか",
            criteria: nodeCriteria(map),
          },
        },
      }),
    });
    if (!res.ok) throw new Error(`Jev ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { answers: Record<string, { noul?: number; choice?: string; confidence?: number }>; usage?: { input_tokens: number; output_tokens: number } };
    const p = (q: string) => body.answers[q]?.noul ?? 0; // noul の答えは true の確率そのもの
    return {
      mapWorthy: p("map_worthy"),
      topicShift: p("topic_shift"),
      target: body.answers.target?.choice ?? "none",
      targetConfidence: body.answers.target?.confidence ?? 0,
      latencyMs: Date.now() - t0,
      usage: { input: body.usage?.input_tokens ?? 0, output: body.usage?.output_tokens ?? 0 },
    };
  }
}

// OpenAI Decisions は limited preview で公開リファレンスが無い。プレビューのドキュメントを見てから埋める。
export class OpenAIDecisionsGate implements Gate {
  name = "openai-decisions";
  async ask(): Promise<GateAnswers> {
    throw new Error("OpenAI Decisions のリクエスト形式が未確認");
  }
}

// ゲートの答えと、まだ Claude に渡していない発言から、次の一手を決める。
// - "flush": 溜まった発言を今 Claude に渡す
// - "wait":  もう少し溜める（マップへの反映は遅れるが、呼び出し回数と文脈の細切れが減る）
// - "drop":  溜まった発言は中身が無いとみなし、Claude に渡さず捨てる（次回以降の「直前の発言」には残る）
// pending: 前回の flush / drop から溜まった発言（最新が末尾）。answers は pending と同じ並び。
// waitedSec: pending の先頭の発言が終わってから、最新の発言が終わるまでの秒数。
export type GateAction = "flush" | "wait" | "drop";
export function decide(pending: Segment[], answers: GateAnswers[], waitedSec: number): GateAction {
  // 閾値 0.3 は eval-gate.ts の結果から: 発言の 24% を捨て、取りこぼす変更は 103 件中 1 件
  if (answers.every((a) => a.mapWorthy < 0.3)) return "drop";
  return pending.length >= 2 ? "flush" : "wait";
}

// 呼ぶときに Claude へ添える見立て。関係しそうなノードを伝えて、update / merge を選びやすくする。
export function hintFor(map: MindMap, answers: GateAnswers[]): string {
  const targets = [...new Set(answers.filter((a) => a.target !== "none" && a.target !== "new").map((a) => a.target))];
  const lines = targets.filter((id) => map.nodes[id]).map((id) => `- ${id} ${map.nodes[id]!.kind}: ${map.nodes[id]!.text}（子 ${children(map, id).length}）`);
  if (answers.some((a) => a.target === "new")) lines.push("- 新しい話題が含まれていそう");
  return lines.length ? `新しい発言に関係しそうなノード:\n${lines.join("\n")}` : "";
}
