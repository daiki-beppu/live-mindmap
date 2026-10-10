// 試作（Issue #736）: セッションのフォルダに、今の map-audio.html・map.html と並べて開ける Foldkit 版を書く。
// 使い方: pnpm --filter @live-mindmap/web prototype:foldkit <セッションのフォルダ>
// 録音があれば、map-audio.html に埋め込まれた音声をそのまま写して map-audio-foldkit.html を、無ければ map-foldkit.html を書く。
// 既存のファイルは消さない・書き換えない（書くのは *-foldkit.html だけ）
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { embedReviewAudio, embedReviewLog, REVIEW_AUDIO_ELEMENT_ID } from "../../../server/src/core/review.ts";

const arg = process.argv[2];
if (!arg) throw new Error("セッションのフォルダを渡してください");
const dir = resolve(arg);
const events = readFileSync(join(dir, "log.jsonl"), "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line) as unknown);
const recorded = readdirSync(dir).some((f) => /^(相手|自分).*\.m4a$/.test(f));
const audioPage = join(dir, "map-audio.html");
if (recorded && !existsSync(audioPage)) throw new Error(`録音はあるが map-audio.html がない。先に pnpm --filter @live-mindmap/server cli review ${dir} で今の画面版を作る`);

const out = mkdtempSync(join(tmpdir(), "live-mindmap-foldkit-"));
try {
  await build({ configFile: join(import.meta.dirname, "vite.config.ts"), logLevel: "warn", plugins: [viteSingleFile()], build: { outDir: out, emptyOutDir: true, minify: process.env.FOLDKIT_MINIFY !== "0" } });
  let html = embedReviewLog(readFileSync(join(out, "index.html"), "utf8"), events);
  let file = "map-foldkit.html";
  if (recorded) {
    const page = readFileSync(audioPage, "utf8");
    const open = `<script type="text/plain" id="${REVIEW_AUDIO_ELEMENT_ID}">`;
    const start = page.lastIndexOf(open);
    if (start < 0) throw new Error(`${audioPage} に音声の要素がない`);
    html = embedReviewAudio(html, page.slice(start + open.length, page.indexOf("</script>", start)));
    file = "map-audio-foldkit.html";
  }
  writeFileSync(join(dir, file), html);
  console.log(join(dir, file));
} finally {
  rmSync(out, { recursive: true, force: true });
}
