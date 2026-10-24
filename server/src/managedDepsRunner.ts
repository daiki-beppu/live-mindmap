import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { linkSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const [owner, command, ...args] = process.argv.slice(2);
if (owner === undefined || command === undefined) throw new Error("導入ランナーの引数がありません");
// Windows の PID 生存だけでは子孫の寿命を確認できない。方式が決まるまで外部導入を開始しない。
if (process.platform === "win32") throw new Error("Windows の導入プロセスの終了確認方式が未対応です");
const uuid = randomUUID();
const guard = dirname(owner);
const temporary = `${guard}-${uuid}.execution`;
const execution = join(guard, `execution-${uuid}`);
writeFileSync(temporary, String(-process.pid), { flag: "wx", mode: 0o600 });
try {
  linkSync(temporary, execution);
} finally {
  unlinkSync(temporary);
}
if (Number(readFileSync(owner, "utf8")) !== process.ppid) throw new Error("導入の所有者が交代しました");
const child = spawn(command, args, { stdio: ["ignore", "inherit", "inherit"], detached: false });
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code, signal) => {
  if (signal !== null) console.error(`導入コマンドが ${signal} で終了しました`);
  process.exitCode = code === null ? 1 : code;
});
