import { describe, expect, it } from "vitest";
import { acceptTransferredModel, defaultClaude, listModels, selectModel } from "../src/modelSelection.ts";

const configPath = "/test/config.json";
// 問い合わせ境界が渡す正規化済みの状態。文面ではなく利用可否と理由を選択に渡す。
const availableMac = { osVersion: "27.0", availability: { status: "available" } };
const models = {
  fast: { route: "claude", model: "claude-haiku-5-5" },
  careful: { route: "claude", model: "claude-opus-5-5" },
  ollama: { route: "openai-compatible", model: "qwen", url: "http://localhost:11434/v1" },
  subscription: { route: "chatgpt", model: "gpt-test" },
};

const select = (flags: { model?: string; local?: boolean }, envModel: string | undefined, config: unknown) =>
  selectModel({ flags, envModel, config, configPath, macState: {} });

// The result shape expresses the plan's success / one-line configuration error / two-line refusal.
const refused = (result: ReturnType<typeof selectModel>) => {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("モデル選択が拒否されませんでした");
  expect(result.lines).toHaveLength(2);
  for (const line of result.lines) {
    expect(line.trim()).not.toBe("");
    expect(line).not.toMatch(/[\r\n]/);
  }
  return result.lines;
};

describe("モデル選択（Issue #663）", () => {
  it.each([
    { flags: { local: true }, config: {} },
    { flags: {}, config: { default: "local" } },
    { flags: { model: "apple" }, config: {} },
  ])("利用不可の Mac ではどのローカル指定も Claude に回さず拒否する ($flags / $config)", ({ flags, config }) => {
    const result = selectModel({ flags, config, configPath, envModel: undefined,
      macState: { osVersion: "27.0", availability: { status: "unavailable", reason: "modelNotReady" } },
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("利用不可の Mac でセッションが選択されました");
    expect(result.lines.some((line) => line.trim().length > 0)).toBe(true);
  });
  it("一覧は選択と同じ定義・利用可否を使い、apple だけがローカル対象になる", () => {
    const result = listModels({ config: { models }, configPath, macState: availableMac });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("有効なモデル定義が拒否されました");
    expect(result.models.filter((model) => model.local).map((model) => model.name)).toEqual(["apple"]);
    expect(result.models.filter((model) => model.reason === undefined).map((model) => model.name).sort()).toEqual(["apple", "careful", "claude", "fast", "ollama", "subscription"]);
    expect(listModels({ config: { models: { apple: models.fast } }, configPath, macState: {} }).ok).toBe(false);
  });

  it("転送した Claude・互換・ChatGPT モデルは実行できるが、他モデルの local・apple 上書きは拒否する", () => {
    expect(acceptTransferredModel(defaultClaude)).toEqual({ ok: true, model: defaultClaude });
    const compatible = { name: "ollama", ...models.ollama, route: "openai-compatible" as const, local: false };
    expect(acceptTransferredModel(compatible)).toEqual({ ok: true, model: compatible });
    const subscription = { name: "subscription", ...models.subscription, route: "chatgpt" as const, local: false };
    expect(acceptTransferredModel(subscription)).toEqual({ ok: true, model: subscription });
    for (const model of [
      { ...defaultClaude, local: true },
      { ...defaultClaude, name: "apple" },
      { ...compatible, local: true },
      { ...subscription, local: true },
    ]) expect(acceptTransferredModel(model).ok).toBe(false);
  });

  it.each([false, true])("転送した組み込み apple はローカルの推論先として受理する（local=%s）", (local) => {
    expect(acceptTransferredModel({ name: "apple", route: "apple", local })).toEqual({
      ok: true, model: { name: "apple", route: "apple", local: true },
    });
  });

  it.each([null, [], { models: [] }, { default: 42 }])("設定の外形が不正なら既定 Claude に回さず拒否する (%j)", (config) => {
    const result = select({}, undefined, config);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.lines).toHaveLength(1);
  });

  it("invDefaultClaude: 設定も指定もなければ従来の Claude", () => {
    expect(select({}, undefined, {})).toMatchObject({
      ok: true, model: { name: "claude", route: "claude", model: "claude-sonnet-5-5" }, local: false,
    });
  });

  it.each([
    { flags: { model: "fast" }, env: "careful", config: { default: "claude", models }, name: "fast", model: models.fast.model },
    { flags: {}, env: "careful", config: { default: "fast", models }, name: "careful", model: models.careful.model },
    { flags: {}, env: undefined, config: { default: "fast", models }, name: "fast", model: models.fast.model },
    { flags: { model: "fast" }, env: undefined, config: { default: "local", models }, name: "fast", model: models.fast.model },
    { flags: {}, env: "fast", config: { default: "local", models }, name: "fast", model: models.fast.model },
  ])("selectionPriority: $flags / $env / $config.default → $name", ({ flags, env, config, name, model }) => {
    expect(select(flags, env, config)).toMatchObject({ ok: true, model: { name, route: "claude", model }, local: false });
  });

  it("組み込み claude の定義を上書きできる", () => {
    expect(select({}, undefined, { models: { claude: models.fast } })).toMatchObject({
      ok: true, model: { name: "claude", ...models.fast }, local: false,
    });
  });

  it.each([
    { flags: { local: true }, env: "careful", config: { default: "fast", models } },
    { flags: {}, env: undefined, config: { default: "local", models } },
    { flags: { model: "apple" }, env: undefined, config: {} },
    { flags: { model: "apple", local: true }, env: undefined, config: {} },
  ])("使える Mac では Apple / local を選び、--local が無くてもローカルになる ($flags)", ({ flags, env, config }) => {
    expect(selectModel({ flags, envModel: env, config, configPath, macState: availableMac })).toEqual({
      ok: true, model: { name: "apple", route: "apple", local: true }, local: true,
    });
  });

  it.each([
    { macState: { osVersion: "27.0", availability: { status: "unavailable", reason: "appleIntelligenceNotEnabled" } }, reason: /オフ/, action: /システム設定/ },
    { macState: { osVersion: "27.0", availability: { status: "unavailable", reason: "deviceNotEligible" } }, reason: /機種/, action: /対応/ },
    { macState: { osVersion: "26.4", availability: { status: "available" } }, reason: /macOS 27.*26\.4/, action: /更新|アップデート/ },
    { macState: { osVersion: "27.0", availability: { status: "unavailable", reason: "modelNotReady" } }, reason: /準備中/, action: /待|しばらく/ },
    { macState: { osVersion: "27.0", availability: { status: "unavailable", reason: "futureReason" } }, reason: /futureReason/, action: /確認|確かめ|やり直|再試行/ },
  ])("使えない Mac の apple は理由と次の行動を二行で示し、一覧にも同じ理由を映す ($macState)", ({ macState, reason, action }) => {
    const lines = refused(selectModel({ flags: { model: "apple" }, envModel: "claude", config: {}, configPath, macState }));
    expect(lines[0]).toMatch(reason);
    expect(lines[1]).toMatch(action);
    const listed = listModels({ config: {}, configPath, macState });
    expect(listed.ok).toBe(true);
    if (!listed.ok) throw new Error("有効な一覧を取得できません");
    expect(listed.models.find((model) => model.name === "apple")).toMatchObject({ local: true, reason: lines[0] });
    expect(selectModel({ flags: { model: "claude" }, envModel: undefined, config: {}, configPath, macState })).toMatchObject({ ok: true, model: defaultClaude });
  });

  it.each(["claude", "fast", "ollama", "subscription"])("invLocalWithOtherRefused: --local と %s の併用は拒む", (name) => {
    const lines = refused(select({ local: true, model: name }, undefined, { models }));
    expect(lines[0]).toContain(`ローカルモードでは ${name} を選べません`);
    expect(lines[1]).toContain("apple");
  });

  it.each([
    { flags: { model: "subscription" }, env: "fast", default: "careful" },
    { flags: {}, env: "subscription", default: "fast" },
    { flags: {}, env: undefined, default: "subscription" },
  ])("C04: 設定名で ChatGPT を選べる ($flags / $env / $default)", ({ flags, env, default: defaultName }) => {
    expect(select(flags, env, { default: defaultName, models })).toEqual({
      ok: true, model: { name: "subscription", ...models.subscription, local: false }, local: false,
    });
  });

  it.each([
    { route: "chatgpt" },
    { route: "chatgpt", model: "" },
    { ...models.subscription, url: "https://test.invalid/v1" },
    { ...models.subscription, apiKeyEnv: "SYNTHETIC_KEY" },
  ])("C04: ChatGPT は model 必須、url・apiKeyEnv 禁止 (%j)", (definition) => {
    const result = select({ model: "subscription" }, undefined, { models: { subscription: definition } });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("契約外の ChatGPT 設定が受理されました");
    expect(result.lines).toHaveLength(1);
  });

  it("7 項目を持つ OpenAI 互換の定義は設定エラーにならない", () => {
    const config = { models: { compatible: {
      route: "openai-compatible", model: "qwen", url: "http://localhost:11434/v1",
      apiKeyEnv: "TEST_MODEL_KEY", images: false, maxTokens: 4096, extraBody: { temperature: 0 },
    } } };
    expect(select({ model: "claude" }, undefined, config)).toMatchObject({ ok: true });
    expect(select({ model: "compatible" }, undefined, config)).toEqual({ ok: true, model: { name: "compatible", ...config.models.compatible, local: false }, local: false });
  });

  it.each([
    { flags: { model: "ollama" }, env: "fast", default: "careful" },
    { flags: {}, env: "ollama", default: "fast" },
    { flags: {}, env: undefined, default: "ollama" },
  ])("C01: 互換経路も選択優先順位を保ちlocalhostをlocal扱いしない ($flags / $env / $default)", ({ flags, env, default: defaultName }) => {
    expect(select(flags, env, { default: defaultName, models })).toEqual({
      ok: true, model: { name: "ollama", ...models.ollama, local: false }, local: false,
    });
  });

  it.each(["missing", "chatgpt"])("unknownModelDiagnostic: %s は候補と設定パスを含む 2 行", (name) => {
    const lines = refused(select({ model: name }, undefined, { models }));
    expect(lines[0]).toContain(name);
    expect(lines[0]).toContain("設定にありません");
    for (const candidate of ["claude", "apple", ...Object.keys(models)]) expect(lines[1]).toContain(candidate);
    expect(lines[1]).toContain(configPath);
  });

  it.each([
    { name: "apple", definition: { route: "claude", model: "override" }, field: "apple" },
    { name: "bad", definition: { route: "openai-compatible", model: "qwen" }, field: "url" },
    { name: "bad", definition: { route: "invalid", model: "qwen" }, field: "route" },
    { name: "bad", definition: { route: "claude", model: 123 }, field: "model" },
    { name: "bad", definition: { route: "claude", model: "qwen", images: "false" }, field: "images" },
    { name: "bad", definition: { route: "claude", model: "qwen", maxTokens: "4096" }, field: "maxTokens" },
    { name: "bad", definition: { route: "openai-compatible", model: "qwen", url: "http://localhost", apiKeyEnv: 1 }, field: "apiKeyEnv" },
    { name: "bad", definition: { route: "claude", model: "qwen", extraBody: [] }, field: "extraBody" },
  ])("configDiagnostic: models.$name の $field の誤りは 1 行で拒む", ({ name, definition, field }) => {
    const result = select({ model: "claude" }, undefined, { models: { [name]: definition } });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("不正な設定が受理されました");
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toMatch(/^設定ファイルが不正です: .+（.+: .+）$/);
    expect(result.lines[0]).toContain(configPath);
    expect(result.lines[0]).toContain(`models.${name}`);
    if (name !== "apple") expect(result.lines[0]).toContain(field);
    expect(result.lines[0]).not.toMatch(/[\r\n]/);
  });
});
