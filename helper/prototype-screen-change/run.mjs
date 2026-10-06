// PROTOTYPE（使い捨て、issue #252）: 別の Chrome（隠れても描き続ける設定）で台本ページを開き、record で取り込む。
// 146 秒に別のタブへ、156 秒に戻す（DevTools プロトコル）。使い方: node run.mjs <record のパス> <出力先>
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
const [record, out] = process.argv.slice(2);
const dir = import.meta.dirname, port = 9333;
const t0 = Date.now() + 8000;
writeFileSync(path.join(out, "t0.json"), JSON.stringify({ t0 }));
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
  `--user-data-dir=${path.join(out, "chrome-profile")}`, `--remote-debugging-port=${port}`,
  "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-background-timer-throttling",
  "--no-first-run", "--no-default-browser-check", "--window-size=1280,800", "--window-position=100,60",
  `file://${dir}/scenario.html?t0=${t0}`,
], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(4000);
const rec = spawn(record, ["com.google.Chrome", out, "175", "4", "麦の穂"], { stdio: "inherit" });
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const meet = list.find((t) => t.type === "page" && t.url.includes("scenario.html"));
const browser = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl;
const ws = new WebSocket(browser); await new Promise((r) => (ws.onopen = r));
let id = 0; const send = (method, params) => ws.send(JSON.stringify({ id: ++id, method, params }));
await sleep(t0 + 146000 - Date.now()); send("Target.createTarget", { url: `file://${dir}/other.html` }); console.log("other tab");
await sleep(t0 + 156000 - Date.now()); send("Target.activateTarget", { targetId: meet.id }); console.log("back");
await new Promise((r) => rec.on("exit", r));
chrome.kill();
