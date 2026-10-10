// 試作（Issue #736）: Foldkit 版の見返しを single-file の HTML にする設定（write.ts が使う）。React のプラグインは使わない
import { defineConfig } from "vite";

export default defineConfig({ root: import.meta.dirname, base: "./" });
