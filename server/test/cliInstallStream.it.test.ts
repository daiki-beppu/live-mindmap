import { execFile } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const cli = join(import.meta.dirname, "../src/cli.ts");

const cliProcess = (dir: string, port: number, args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
  execFile(process.execPath, [cli, ...args], {
    timeout: 10_000,
    env: { ...process.env, LIVE_MINDMAP_PORT: String(port), LIVE_MINDMAP_SESSIONS: dir, LIVE_MINDMAP_CONFIG: join(dir, "absent.config.json"), LIVE_MINDMAP_MODEL: "", NO_COLOR: "1" },
  }, (error, stdout, stderr) => {
    if (error && (error.killed || typeof error.code !== "number")) return reject(error);
    resolve({ code: error ? error.code as number : 0, stdout, stderr });
  });
});

describe("CLI install のストリーム受信", () => {
  it.each([
    { name: "完了前の EOF", body: '{"type":"progress","message":"確認"}\n' },
    { name: "不正なイベント", body: '{"type":"unexpected"}\n' },
    { name: "不正な JSON", body: 'not json\n' },
  ].map((test) => ({ ...test, status: 200, args: ["install", "chromium"], path: "/deps/install", reason: undefined as string | undefined })).concat(
    [
      { name: "error 文面 A", body: '{"error":"失敗A"}', reason: "失敗A" },
      { name: "error 文面 B", body: '{"error":"失敗B"}', reason: "失敗B" },
      { name: "空本文", body: "", reason: "サーバーがエラーを返しました: 503" },
      { name: "不正 JSON", body: "not json", reason: "サーバーがエラーを返しました: 503" },
      { name: "Schema 不適合", body: '{"error":123}', reason: "サーバーがエラーを返しました: 503" },
      { name: "error 欠落", body: "{}", reason: "サーバーがエラーを返しました: 503" },
    ].flatMap((test) => [
      { ...test, name: `stop の非2xx ${test.name}`, status: 503, args: ["stop"], path: "/session/stop" },
      { ...test, name: `install の非2xx ${test.name}`, status: 503, args: ["install", "chromium"], path: "/deps/install" },
    ]),
  ))("$name は成功 items を出さず exit 1 にする", async ({ body, status, args, path, reason }) => {
    const dir = await mkdtemp(join(tmpdir(), "live-mindmap-install-stream-"));
    const requests: { method: string | undefined; url: string | undefined; body: string }[] = [];
    const server = createServer((request, response) => {
      let input = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { input += chunk; });
      request.on("end", () => {
        requests.push({ method: request.method, url: request.url, body: input });
        response.writeHead(status, { "content-type": status === 200 ? "application/x-ndjson" : "application/json" });
        response.end(body);
      });
    });
    try {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
      const port = (server.address() as AddressInfo).port;
      const result = await cliProcess(dir, port, args);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ method: "POST", url: path });
      if (path === "/deps/install") expect(JSON.parse(requests[0]!.body)).toEqual({ names: ["chromium"] });
      else expect(requests[0]!.body).toBe("");
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr.trim()).not.toBe("");
      if (reason !== undefined) expect(result.stderr).toContain(reason + "\n");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stop の接続不能は指定文面と空 stdout、exit 1 を返す", async () => {
    const dir = await mkdtemp(join(tmpdir(), "live-mindmap-unreachable-"));
    try {
      const result = await cliProcess(dir, 0, ["stop"]);
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("サーバーにつながりません（pnpm dev で起動）\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
