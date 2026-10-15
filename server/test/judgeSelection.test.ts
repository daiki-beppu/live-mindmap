import { describe, expect, it } from "vitest";
import { selectJudge } from "../src/judgeSelection.ts";

const configPath = "/test/config.json";
const key = "TYPESAFE_AI_API_KEY";
const withKey = { [key]: "synthetic-key" };
const judges = {
  fast: { route: "system-one", apiKeyEnv: "FAST_JUDGE_KEY", timeoutMs: 500 },
  slow: { route: "system-one", apiKeyEnv: "SLOW_JUDGE_KEY" },
};
const allKeys = { ...withKey, FAST_JUDGE_KEY: "fast-key", SLOW_JUDGE_KEY: "slow-key" };

type Options = {
  flag?: string; env?: string; config?: unknown; local?: boolean; apiKeys?: Readonly<Record<string, string | undefined>>;
};
const select = ({ flag, env, config = {}, local = false, apiKeys = withKey }: Options = {}) =>
  selectJudge({ flags: { judge: flag }, envJudge: env, config, configPath, local, apiKeys });

const refused = (result: ReturnType<typeof select>) => {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("判定のモデル選択が拒否されませんでした");
  return result.lines;
};
const twoLines = (result: ReturnType<typeof select>) => {
  const lines = refused(result);
  expect(lines).toHaveLength(2);
  for (const line of lines) {
    expect(line.trim()).not.toBe("");
    expect(line).not.toMatch(/[\r\n]/);
  }
  return lines;
};
const noJudge = (result: ReturnType<typeof select>) => {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("判定なしで始まるはずの選択が拒否されました");
  expect(result.judge).toBeUndefined();
  return result;
};

describe("判定のモデル選択（Issue #983）", () => {
  it("既定（何も書かない）で鍵があれば組み込みの jev が system-one・時間切れ 1 秒で選ばれる", () => {
    const result = select();
    expect(result).toMatchObject({ ok: true, judge: { name: "jev", route: "system-one", apiKeyEnv: key, timeoutMs: 1000 } });
    if (result.ok) expect(result.notice).toBeUndefined();
  });

  it.each([
    { flag: "fast", env: "slow", config: { judge: "jev", judges }, name: "fast" },
    { flag: undefined, env: "slow", config: { judge: "fast", judges }, name: "slow" },
    { flag: undefined, env: undefined, config: { judge: "fast", judges }, name: "fast" },
    { flag: "slow", env: undefined, config: { judge: "fast", judges }, name: "slow" },
    { flag: undefined, env: undefined, config: { judges }, name: "jev" },
  ])("selectionPriority: $flag / $env / $config.judge → $name", ({ flag, env, config, name }) => {
    expect(select({ flag, env, config, apiKeys: allKeys })).toMatchObject({ ok: true, judge: { name, route: "system-one" } });
  });

  it("設定で定義した判定のモデルは自分の鍵の環境変数と時間切れを使い、時間切れの既定は 1 秒", () => {
    expect(select({ flag: "fast", config: { judges }, apiKeys: allKeys })).toMatchObject({
      ok: true, judge: { name: "fast", apiKeyEnv: "FAST_JUDGE_KEY", timeoutMs: 500 },
    });
    expect(select({ flag: "slow", config: { judges }, apiKeys: allKeys })).toMatchObject({
      ok: true, judge: { name: "slow", apiKeyEnv: "SLOW_JUDGE_KEY", timeoutMs: 1000 },
    });
  });

  it("judges.jev を書くと組み込みの jev を置き換える", () => {
    expect(select({ config: { judges: { jev: judges.fast } }, apiKeys: allKeys })).toMatchObject({
      ok: true, judge: { name: "jev", apiKeyEnv: "FAST_JUDGE_KEY", timeoutMs: 500 },
    });
  });

  it("差分更新のモデルの設定（default・models）が同居していても判定の選択は断らない", () => {
    const config = { default: "fast", models: { fast: { route: "claude", model: "claude-haiku-5-5" } }, judge: "slow", judges };
    expect(select({ config, apiKeys: allKeys })).toMatchObject({ ok: true, judge: { name: "slow" } });
  });

  it.each([
    { flag: "off", env: "jev", config: { judge: "fast", judges } },
    { flag: undefined, env: "off", config: { judge: "fast", judges } },
    { flag: undefined, env: undefined, config: { judge: "off", judges } },
    { flag: "off", env: undefined, config: {} },
  ])("invOffMeansNoJudge: off は鍵があっても判定なしで、知らせも出さない ($flag / $env / $config.judge)", ({ flag, env, config }) => {
    expect(noJudge(select({ flag, env, config, apiKeys: allKeys })).notice).toBeUndefined();
  });

  it("flag の off は、env や設定が未知の名前でも判定なしで始まる（優先順の上位で決まる）", () => {
    expect(noJudge(select({ flag: "off", env: "missing", config: { judge: "missing2" } })).notice).toBeUndefined();
  });

  it.each([
    { apiKeys: {} },
    { apiKeys: { [key]: undefined } },
    { apiKeys: { [key]: "" } },
    { apiKeys: { [key]: "  \t" } },
  ])("invNoKeyStartsWithoutJudge: 鍵が無い・空なら断らず 1 行の知らせとともに判定なしで始まる ($apiKeys)", ({ apiKeys }) => {
    const result = noJudge(select({ apiKeys }));
    expect(result.ok && result.notice).toEqual(expect.any(String));
    const notice = result.ok ? result.notice ?? "" : "";
    expect(notice.trim()).not.toBe("");
    expect(notice).not.toMatch(/[\r\n]/);
    expect(notice).toContain("jev");
    expect(notice).toContain(key);
  });

  it("選んだ判定のモデルの鍵だけを見る: 別のモデルの鍵があっても、選んだモデルの鍵が無ければ判定なし", () => {
    const result = noJudge(select({ flag: "fast", config: { judges }, apiKeys: { ...withKey, SLOW_JUDGE_KEY: "slow-key" } }));
    expect(result.ok && result.notice).toContain("FAST_JUDGE_KEY");
  });

  it("名前に改行が含まれても知らせは 1 行", () => {
    const config = { judges: { "a\nb": { route: "system-one", apiKeyEnv: "X_KEY" } } };
    const result = noJudge(select({ flag: "a\nb", config, apiKeys: {} }));
    expect(result.ok && result.notice).not.toMatch(/[\r\n]/);
  });

  it.each([
    { flag: "missing", env: undefined, config: { judges } },
    { flag: undefined, env: "missing", config: { judges } },
    { flag: undefined, env: undefined, config: { judge: "missing", judges } },
    { flag: "claude", env: undefined, config: {} },
  ])("unknownJudgeDiagnostic: 知らない名前は候補と設定パスを含む 2 行で断る ($flag / $env / $config.judge)", ({ flag, env, config }) => {
    const lines = twoLines(select({ flag, env, config, apiKeys: allKeys }));
    expect(lines[0]).toContain(flag ?? env ?? (config as { judge?: string }).judge ?? "");
    expect(lines[0]).toContain("設定にありません");
    for (const candidate of ["jev", "off", ...Object.keys((config as { judges?: object }).judges ?? {})]) expect(lines[1]).toContain(candidate);
    expect(lines[1]).toContain(configPath);
  });

  it.each([
    { judge: 42 },
    { judge: "" },
    { judges: [] },
    { judges: null },
    { judges: { bad: { route: "claude", apiKeyEnv: "K" } } },
    { judges: { bad: { route: "system-one" } } },
    { judges: { bad: { route: "system-one", apiKeyEnv: "" } } },
    { judges: { bad: { route: "system-one", apiKeyEnv: 1 } } },
    { judges: { bad: { route: "system-one", apiKeyEnv: "K", timeoutMs: "1000" } } },
    { judges: { bad: { route: "system-one", apiKeyEnv: "K", timeoutMs: 0 } } },
    { judges: { bad: { route: "system-one", apiKeyEnv: "K", timeoutMs: 1.5 } } },
    { judges: { bad: { route: "system-one", apiKeyEnv: "K", extra: true } } },
    { judges: { off: { route: "system-one", apiKeyEnv: "K" } } },
    { unknownKey: true },
  ])("configDiagnostic: judges の書き誤りは場所・項目・理由の 1 行で断る (%j)", (config) => {
    const lines = refused(select({ config, apiKeys: allKeys }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^設定ファイルが不正です: .+（.+: .+）$/);
    expect(lines[0]).toContain(configPath);
    expect(lines[0]).not.toMatch(/[\r\n]/);
  });

  it.each([
    { config: { judges: { bad: { route: "claude", apiKeyEnv: "K" } } }, where: "judges.bad", field: "route" },
    { config: { judges: { bad: { route: "system-one" } } }, where: "judges.bad", field: "apiKeyEnv" },
    { config: { judges: { bad: { route: "system-one", apiKeyEnv: "K", timeoutMs: 0 } } }, where: "judges.bad", field: "timeoutMs" },
    { config: { judges: { bad: { route: "system-one", apiKeyEnv: "K", extra: true } } }, where: "judges.bad", field: "extra" },
    { config: { judges: { off: { route: "system-one", apiKeyEnv: "K" } } }, where: "judges.off", field: "off" },
    { config: { judge: 42 }, where: "設定", field: "judge" },
  ])("configDiagnostic: $where の $field を示す", ({ config, where, field }) => {
    const [line] = refused(select({ config, apiKeys: allKeys }));
    expect(line).toContain(where);
    expect(line).toContain(field);
  });

  it("設定の誤りは名前の選択より先に断る（off を指定しても、鍵が無くても）", () => {
    expect(refused(select({ flag: "off", config: { judges: { bad: { route: "claude" } } }, apiKeys: {} }))).toHaveLength(1);
  });

  it.each([
    { name: "apiKeyEnv の無い項目", judges: { bad: { route: "system-one" } }, field: "apiKeyEnv" },
    { name: "組み込みでない名前の時間切れだけの項目", judges: { bad: { timeoutMs: 500 } }, field: "route" },
  ])("--judge off でも、$name は 1 行の診断で断る", ({ judges, field }) => {
    const lines = refused(select({ flag: "off", config: { judges }, apiKeys: {} }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(field);
  });

  describe("ローカルモード", () => {
    it.each([
      { flag: "jev", env: undefined, config: {} },
      { flag: undefined, env: "jev", config: {} },
      { flag: undefined, env: undefined, config: { judge: "jev" } },
      { flag: "fast", env: undefined, config: { judges } },
      { flag: undefined, env: undefined, config: { judge: "fast", judges } },
    ])("invLocalNoCloudJudge: クラウドの判定のモデルを明示したら断る ($flag / $env / $config.judge)", ({ flag, env, config }) => {
      const lines = twoLines(select({ flag, env, config, local: true, apiKeys: allKeys }));
      expect(lines[0]).toContain("ローカルモードでは");
      expect(lines[0]).toContain(flag ?? env ?? (config as { judge?: string }).judge ?? "");
      expect(lines[1]).toContain("--judge off");
      expect(lines[1]).toContain("LIVE_MINDMAP_JUDGE");
      expect(lines[1]).toContain("judge");
    });

    it("明示は優先順の勝者で判断する: flag が off なら env や設定の jev があっても判定なしで始まる", () => {
      expect(noJudge(select({ flag: "off", env: "jev", config: { judge: "jev" }, local: true })).notice).toBeUndefined();
    });

    it("invRefuseOnlyExplicitCloudInLocal: 何も明示しなければ既定の jev でも断らず、鍵があっても知らせず判定なしで始まる", () => {
      expect(noJudge(select({ local: true, apiKeys: allKeys })).notice).toBeUndefined();
      expect(noJudge(select({ local: true, config: { judges }, apiKeys: allKeys })).notice).toBeUndefined();
    });

    it("何も明示せず鍵も無いローカルモードでも、鍵の知らせは出さない", () => {
      expect(noJudge(select({ local: true, apiKeys: {} })).notice).toBeUndefined();
    });

    it("off を明示したローカルモードは判定なし", () => {
      for (const options of [{ flag: "off" }, { env: "off" }, { config: { judge: "off" } }]) {
        expect(noJudge(select({ ...options, local: true, apiKeys: allKeys })).notice).toBeUndefined();
      }
    });

    it("ローカルモードで明示し、かつ鍵が無ければ、知らせではなく断る", () => {
      expect(twoLines(select({ flag: "jev", local: true, apiKeys: {} }))[0]).toContain("ローカルモードでは");
    });

    it("ローカルモードでも知らない名前は候補を示す断りになる", () => {
      const lines = twoLines(select({ flag: "missing", local: true, apiKeys: allKeys }));
      expect(lines[0]).toContain("設定にありません");
    });

    it("ローカルモードでも設定の誤りは 1 行の診断で断る", () => {
      expect(refused(select({ config: { judge: 42 }, local: true }))).toHaveLength(1);
    });
  });
});

describe("Clef の組み込みと時間切れの上書き（Issue #985）", () => {
  const cf = { CLOUDFLARE_API_TOKEN: "cf-token", CLOUDFLARE_ACCOUNT_ID: "acct-123" };
  const chosen = (result: ReturnType<typeof select>) => {
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("選択が拒否されました");
    return result;
  };

  it.each([
    { name: "clef-flash", model: "clef-flash" },
    { name: "clef", model: "clef" },
  ])("--judge $name: 鍵が 2 つあれば system-one・モデル名は名前と同じ・Cloudflare の鍵・時間切れ 2 秒で選ばれる", ({ name, model }) => {
    const result = chosen(select({ flag: name, apiKeys: cf }));
    expect(result.judge).toMatchObject({
      name, route: "system-one", model, apiKeyEnv: "CLOUDFLARE_API_TOKEN", accountIdEnv: "CLOUDFLARE_ACCOUNT_ID", timeoutMs: 2000,
    });
    expect(result.judge?.url).toBeUndefined();
    if (result.ok) expect(result.notice).toBeUndefined();
  });

  it("組み込みの時間切れは jev 1 秒・clef-flash／clef 2 秒", () => {
    const timeout = (flag: string) => chosen(select({ flag, apiKeys: { ...withKey, ...cf } })).judge?.timeoutMs;
    expect([timeout("jev"), timeout("clef-flash"), timeout("clef")]).toEqual([1000, 2000, 2000]);
  });

  it("候補の一覧に clef-flash・clef が出る（知らない名前の断り）", () => {
    const lines = twoLines(select({ flag: "missing", apiKeys: allKeys }));
    for (const candidate of ["jev", "clef-flash", "clef", "off"]) expect(lines[1]).toContain(candidate);
  });

  it.each([
    { name: "clef", timeoutMs: 3000, apiKeys: cf, expected: { apiKeyEnv: "CLOUDFLARE_API_TOKEN", accountIdEnv: "CLOUDFLARE_ACCOUNT_ID", model: "clef" } },
    { name: "clef-flash", timeoutMs: 500, apiKeys: cf, expected: { apiKeyEnv: "CLOUDFLARE_API_TOKEN", accountIdEnv: "CLOUDFLARE_ACCOUNT_ID", model: "clef-flash" } },
    { name: "jev", timeoutMs: 2500, apiKeys: withKey, expected: { apiKeyEnv: key } },
  ])("judges.$name = { timeoutMs } だけで時間切れを上書きでき、宛先・モデル名・鍵は組み込みのまま", ({ name, timeoutMs, apiKeys, expected }) => {
    const result = chosen(select({ flag: name, config: { judges: { [name]: { timeoutMs } } }, apiKeys }));
    expect(result.judge).toMatchObject({ name, route: "system-one", timeoutMs, ...expected });
  });

  it("上書きは指定した 1 つだけに効き、ほかの組み込みの時間切れは変えない", () => {
    const config = { judges: { clef: { timeoutMs: 3000 } } };
    expect(chosen(select({ flag: "clef-flash", config, apiKeys: cf })).judge?.timeoutMs).toBe(2000);
    expect(chosen(select({ config, apiKeys: withKey })).judge).toMatchObject({ name: "jev", timeoutMs: 1000 });
  });

  it("自分で足した system-one の判定のモデルの時間切れの既定は 1 秒で、書けばその値になる", () => {
    expect(chosen(select({ flag: "slow", config: { judges }, apiKeys: allKeys })).judge?.timeoutMs).toBe(1000);
    expect(chosen(select({ flag: "fast", config: { judges }, apiKeys: allKeys })).judge?.timeoutMs).toBe(500);
  });

  it("judges.clef に route と鍵を含む完全な定義を書くと組み込みを置き換え、組み込みの accountIdEnv は残らない", () => {
    const config = { judges: { clef: { route: "system-one", apiKeyEnv: "MY_KEY", url: "http://test.invalid/clef" } } };
    const result = chosen(select({ flag: "clef", config, apiKeys: { MY_KEY: "k" } }));
    expect(result.judge).toMatchObject({ name: "clef", apiKeyEnv: "MY_KEY", url: "http://test.invalid/clef", timeoutMs: 1000 });
    expect(result.judge?.accountIdEnv).toBeUndefined();
    expect(result.judge?.model).toBeUndefined();
  });

  it.each([
    { apiKeys: { CLOUDFLARE_API_TOKEN: "t" }, missing: "CLOUDFLARE_ACCOUNT_ID" },
    { apiKeys: { CLOUDFLARE_ACCOUNT_ID: "a" }, missing: "CLOUDFLARE_API_TOKEN" },
    { apiKeys: { CLOUDFLARE_API_TOKEN: "t", CLOUDFLARE_ACCOUNT_ID: "  " }, missing: "CLOUDFLARE_ACCOUNT_ID" },
    { apiKeys: { CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "a" }, missing: "CLOUDFLARE_API_TOKEN" },
    { apiKeys: { CLOUDFLARE_API_TOKEN: undefined, CLOUDFLARE_ACCOUNT_ID: "a" }, missing: "CLOUDFLARE_API_TOKEN" },
    { apiKeys: {}, missing: "CLOUDFLARE_API_TOKEN" },
  ])("Cloudflare の鍵のどちらかが無い・空なら、欠けた名前を含む 1 行の知らせとともに判定なしで始まる ($missing)", ({ apiKeys, missing }) => {
    for (const flag of ["clef", "clef-flash"]) {
      const result = noJudge(select({ flag, apiKeys: { ...withKey, ...apiKeys } }));
      const notice = result.ok ? result.notice ?? "" : "";
      expect(notice.trim()).not.toBe("");
      expect(notice).not.toMatch(/[\r\n]/);
      expect(notice).toContain(flag);
      expect(notice).toContain(missing);
    }
  });

  it("env と設定の judge でも clef を選べる", () => {
    expect(chosen(select({ env: "clef", apiKeys: cf })).judge).toMatchObject({ name: "clef" });
    expect(chosen(select({ config: { judge: "clef-flash" }, apiKeys: cf })).judge).toMatchObject({ name: "clef-flash" });
  });

  it.each([
    { judges: { bad: { timeoutMs: 500 } }, field: "route" },
    { judges: { clef: { timeoutMs: 500, model: "other" } }, field: "model" },
    { judges: { clef: { timeoutMs: 500, url: "http://x.invalid" } }, field: "url" },
    { judges: { clef: { timeoutMs: 0 } }, field: "timeoutMs" },
    { judges: { clef: { timeoutMs: "3000" } }, field: "timeoutMs" },
    { judges: { clef: {} }, field: "clef" },
    { judges: { jev: { route: "system-one", timeoutMs: 500 } }, field: "apiKeyEnv" },
    { judges: { bad: { route: "system-one" } }, field: "apiKeyEnv" },
  ])("時間切れだけの項目の書き誤りは 1 行の診断で断る (%j)", ({ judges: bad, field }) => {
    const lines = refused(select({ config: { judges: bad }, apiKeys: { ...allKeys, ...cf } }));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^設定ファイルが不正です: .+（.+: .+）$/);
    expect(lines[0]).toContain(configPath);
    expect(lines[0]).toContain(field);
    expect(lines[0]).not.toMatch(/[\r\n]/);
  });

  describe("ローカルモード（#983 と同じ扱い）", () => {
    it.each([
      { flag: "clef", env: undefined, config: {} },
      { flag: "clef-flash", env: undefined, config: {} },
      { flag: undefined, env: "clef", config: {} },
      { flag: undefined, env: undefined, config: { judge: "clef-flash" } },
    ])("明示したら断る ($flag / $env / $config.judge)", ({ flag, env, config }) => {
      const lines = twoLines(select({ flag, env, config, local: true, apiKeys: cf }));
      expect(lines[0]).toContain("ローカルモードでは");
      expect(lines[1]).toContain("--judge off");
    });

    it("明示しなければ、Cloudflare の鍵があっても無くても知らせず判定なしで始まる", () => {
      expect(noJudge(select({ local: true, config: { judges: { clef: { timeoutMs: 3000 } } }, apiKeys: cf })).notice).toBeUndefined();
      expect(noJudge(select({ local: true, apiKeys: {} })).notice).toBeUndefined();
    });
  });
});
