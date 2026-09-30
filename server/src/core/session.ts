// セッション: 発言の流れを受け、差分更新を呼んでマップを組み立てる。
// WebSocket・CLI・Node の実行環境に依存しない（ADR 0003）。ログの書き先は外から渡す。
import { applyOps, emptyMap, issueStatus, ROOT_ID, type Dropped, type MapNode, type MindMap, type Op } from "./map.ts";

export type Track = "自分" | "相手";

export type Utterance = {
  id: string;
  track: Track;
  start: number; // 会議の中の秒
  end: number;
  text: string;
  duplicate?: boolean; // 重複の印。付いた発言は差分更新に使わない
};

export type DiffInput = {
  rootId: string;
  map: MindMap;
  recent: Utterance[]; // 直前に処理済みの発言（文脈用）
  fresh: Utterance[]; // 新しい発言
};
export type DiffOutput = { ops: Op[] };
export type DiffUpdater = (input: DiffInput) => Promise<DiffOutput>;

export type LogEvent =
  | { type: "utterance"; utterance: Utterance }
  // input は入力の要約: 渡した発言の ID と、呼び出した時点のノード数（ルートを除く）
  | { type: "diff"; input: { recent: string[]; fresh: string[]; nodeCount: number }; ops: Op[]; dropped: Dropped[]; error?: string };

// 論点の状態は保存していないので、スナップショットを作るときに導いて載せる
export type SnapshotNode = MapNode & { status?: "未決" | "決定済み" };
export type Snapshot = { rootId: string; nodes: SnapshotNode[] };

export type SessionOptions = { title: string; updater: DiffUpdater; log: (event: LogEvent) => void };

const BATCH = 2;
const RECENT = 3;

export function createSession({ title, updater, log }: SessionOptions) {
  let map = emptyMap(title);
  let pending: Utterance[] = [];
  let processed: Utterance[] = [];
  const known = new Set<string>(); // 差分更新に渡した発言の ID
  let inFlight: Promise<void> | null = null;

  // 呼び出し中でなく、発言が 2 つ以上たまっていれば、たまった分をまとめて渡す。
  // 呼び出しの後に 1 つしか残っていなくても、2 つ目を待つ（試作 v3 で確かめた入力の形に揃える）。
  function kick(min = BATCH) {
    if (inFlight || pending.length < min) return;
    const fresh = pending;
    pending = [];
    inFlight = call(fresh).finally(() => {
      inFlight = null;
      kick();
    });
  }

  async function call(fresh: Utterance[]) {
    const recent = processed.slice(-RECENT);
    for (const u of fresh) known.add(u.id);
    const input = { recent: recent.map((u) => u.id), fresh: fresh.map((u) => u.id), nodeCount: map.order.length - 1 };
    processed = [...processed, ...fresh];
    let ops: Op[];
    try {
      ({ ops } = await updater({ rootId: ROOT_ID, map, recent, fresh }));
    } catch (e) {
      // 失敗した回の発言は処理済みとして扱い、マップは変えずに次へ進む
      log({ type: "diff", input, ops: [], dropped: [], error: String(e) });
      return;
    }
    const applied = applyOps(map, ops, known);
    map = applied.map;
    log({ type: "diff", input, ops, dropped: applied.dropped });
  }

  return {
    push(u: Utterance) {
      log({ type: "utterance", utterance: u });
      if (u.duplicate) return;
      pending.push(u);
      kick();
    },
    // 呼び出し中のものと、それに続けて起きた呼び出しがすべて終わるまで待つ
    async idle() {
      while (inFlight) await inFlight;
    },
    // 終わりに、2 つに満たず残った発言も流す
    async flush() {
      await this.idle();
      kick(1);
      await this.idle();
    },
    snapshot(): Snapshot {
      const nodes = map.order.map((id): SnapshotNode => {
        const n = structuredClone(map.nodes[id]!);
        return n.kind === "論点" ? { ...n, status: issueStatus(map, id) } : n;
      });
      return { rootId: ROOT_ID, nodes };
    },
  };
}

export type Session = ReturnType<typeof createSession>;
