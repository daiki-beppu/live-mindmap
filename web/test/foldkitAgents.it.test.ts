import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";

// Issue #812: 公式の skill を写し、web の AGENTS.md に Foldkit の規約を書く。ファイルを読むので IT 層。
const repoRoot = join(import.meta.dirname, "..", "..");
const read = (...path: string[]) => readFileSync(join(repoRoot, ...path), "utf8");

const SKILLS = ["audit-program", "foldkit", "generate-program"] as const;
const TAG = "foldkit@0.167.0";

describe("公式の skill の置き場（Claude Code 用と Codex 用）", () => {
  it.each(SKILLS)("%s の実体が .agents/skills に、SKILL.md と一緒にある", (name) => {
    expect(lstatSync(join(repoRoot, ".agents/skills", name)).isDirectory()).toBe(true);
    expect(existsSync(join(repoRoot, ".agents/skills", name, "SKILL.md"))).toBe(true);
  });

  it.each(SKILLS)("%s は .claude/skills から .agents/skills への相対シンボリックリンクで届く", (name) => {
    const link = join(repoRoot, ".claude/skills", name);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    const target = readlinkSync(link);
    expect(isAbsolute(target)).toBe(false);
    expect(target).toBe(`../../.agents/skills/${name}`);
    expect(existsSync(join(link, "SKILL.md"))).toBe(true);
  });

  it("generate-program は補助の資料も写されている", () => {
    for (const f of ["architecture.md", "conventions.md", "checklist.md", "blindSpots.md"]) {
      expect(existsSync(join(repoRoot, ".agents/skills/generate-program", f)), f).toBe(true);
    }
  });

  it("skills-lock.json に出どころ foldkit/foldkit とタグ、3 つの skill が残る", () => {
    const lock = JSON.parse(read("skills-lock.json")) as { skills: Record<string, { source: string; ref?: string; computedHash?: string }> };
    for (const name of SKILLS) {
      const entry = lock.skills[name];
      expect(entry, name).toBeDefined();
      expect(entry?.source).toBe("foldkit/foldkit");
      expect(entry?.ref).toBe(TAG);
      expect(entry?.computedHash).toBeTruthy();
    }
  });
});
