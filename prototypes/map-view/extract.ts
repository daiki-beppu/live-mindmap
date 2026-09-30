// PROTOTYPE — issue #7。差分更新エンジンのラン結果（git 外）から、ビューアが読む軽いデータを public/data に書き出す。
// 公開会議の文字起こし全文を含むので public/data は git に入れない。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";

const dir = `${homedir()}/live-mindmap-samples/diff-engine-runs/runs`;
const runs = [
  "facilitators-meeting__claude-sonnet-5-5__batch2-v3",
  "silly-app-brainstorm__claude-sonnet-5-5__batch2-v3",
  "facilitators-meeting__claude-sonnet-5-5__batch2",
  "facilitators-meeting__claude-sonnet-5-5__batch2-v2",
  "silly-app-brainstorm__claude-sonnet-5-5__batch2-v2",
];
mkdirSync("public/data", { recursive: true });
for (const name of runs) {
  const r = JSON.parse(readFileSync(`${dir}/${name}.json`, "utf8"));
  const out = {
    name,
    segments: r.segments,
    steps: r.steps.map((s: any) => ({
      at: s.at,
      applyAt: s.at + (s.call?.latencyMs ?? 3000) / 1000,
      segIds: s.segIds,
      results: s.results.filter((x: any) => x.ok).map((x: any) => ({ op: x.op.op, nodeId: x.nodeId })),
      map: s.map,
    })),
  };
  writeFileSync(`public/data/${name}.json`, JSON.stringify(out));
  console.log(name, out.steps.length);
}
writeFileSync("public/data/index.json", JSON.stringify(runs));
