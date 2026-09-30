// PROTOTYPE — runs/*.json を viewer.html に埋め込んで、ダブルクリックで開ける report.html を作る
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
const runs = readdirSync("runs").filter((f) => f.endsWith(".json")).sort().map((f) => readFileSync(`runs/${f}`, "utf8"));
const html = readFileSync("viewer.html", "utf8").replace("/*RUNS*/[]", `[${runs.join(",")}]`);
writeFileSync("report.html", html);
console.log(`report.html (${runs.length} runs, ${(html.length / 1e6).toFixed(1)} MB)`);
