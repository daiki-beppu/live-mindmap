import { configDefaults, defineConfig } from "vitest/config";

const IT = "**/*.it.test.?(c|m)[jt]s?(x)";
const HEAVY = "**/*.heavy.test.?(c|m)[jt]s?(x)";

export default defineConfig({
  test: {
    env: { LIVE_MINDMAP_PORT: "0" },
    setupFiles: ["test/setup.ts"],
    testTimeout: 20_000,
    projects: [
      { extends: true, test: { name: "unit", exclude: [...configDefaults.exclude, IT, HEAVY] } },
      { extends: true, test: { name: "it", include: [IT] } },
      { extends: true, test: { name: "heavy", include: [HEAVY] } },
    ],
  },
});
