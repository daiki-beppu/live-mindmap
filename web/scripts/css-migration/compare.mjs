import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const RECT_KEYS = ["x", "y", "width", "height", "top", "right", "bottom", "left"];

export function compare(before, after) {
  if (before.version !== 1 || after.version !== 1 || !Array.isArray(before.scenes) || !Array.isArray(after.scenes)) {
    throw new Error("version 1 の採取JSONが必要です");
  }
  const differences = [];
  const add = (scene, element, property, a, b) => differences.push({ scene, element, property, before: a ?? null, after: b ?? null });
  if (JSON.stringify(before.environment) !== JSON.stringify(after.environment)) add(null, null, "environment", before.environment, after.environment);
  const remaining = new Map(after.scenes.map((s) => [s.name, s]));
  if (remaining.size !== after.scenes.length || new Set(before.scenes.map((s) => s.name)).size !== before.scenes.length) throw new Error("場面名が重複しています");
  for (const scene of before.scenes) {
    const next = remaining.get(scene.name);
    remaining.delete(scene.name);
    if (!next) {
      add(scene.name, null, "scene", "present", "missing");
      continue;
    }
    if (JSON.stringify(scene.viewport) !== JSON.stringify(next.viewport)) add(scene.name, null, "viewport", scene.viewport, next.viewport);
    if (scene.elements.length !== next.elements.length) add(scene.name, null, "element-count", scene.elements.length, next.elements.length);
    for (let i = 0; i < Math.max(scene.elements.length, next.elements.length); i++) {
      const a = scene.elements[i], b = next.elements[i];
      if (!a || !b) {
        add(scene.name, i, "element", a, b);
        continue;
      }
      for (const key of ["path", "tag", "text"]) if (a[key] !== b[key]) add(scene.name, i, key, a[key], b[key]);
      for (const key of new Set([...Object.keys(a.style), ...Object.keys(b.style)])) {
        if (a.style[key] !== b.style[key]) add(scene.name, a.path, "style." + key, a.style[key], b.style[key]);
      }
      for (const key of RECT_KEYS) {
        if (!Number.isFinite(a.rect[key]) || !Number.isFinite(b.rect[key])) throw new Error(scene.name + ": rect." + key + " は有限数が必要です");
        if (Math.abs(a.rect[key] - b.rect[key]) > 0.5) add(scene.name, a.path, "rect." + key, a.rect[key], b.rect[key]);
      }
    }
  }
  for (const name of remaining.keys()) add(name, null, "scene", "missing", "present");
  return { differences: differences.length, details: differences };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [before, after, output] = process.argv.slice(2);
    if (!before || !after || !output) throw new Error("node compare.mjs BEFORE.json AFTER.json DIFF.json");
    const result = compare(JSON.parse(await readFile(before, "utf8")), JSON.parse(await readFile(after, "utf8")));
    await writeFile(output, JSON.stringify(result, null, 2) + "\n");
    process.stdout.write(JSON.stringify({ differences: result.differences, output }) + "\n");
    process.exitCode = result.differences === 0 ? 0 : 1;
  } catch (error) {
    process.stderr.write(String(error) + "\n");
    process.exitCode = 1;
  }
}
