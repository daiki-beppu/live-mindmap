// セッション: 発言の流れを受け、差分更新を呼んでマップを組み立てる。
// WebSocket・CLI・Node の実行環境に依存しない（ADR 0003）。ログの書き先は外から渡す。
import { toJsonExport, type JsonExport } from "./export.ts";
import { applyOps, cloneNode, emptyMap, pointStatus, type Dropped, type MapNode, type MeetingMap, type Op, type PointStatus } from "./map.ts";

export type Track = "自分" | "相手";

// 発言（CONTEXT.md）
export type Remark = {
  id: string;
  track: Track;
  start: number; // 会議の中の秒
  end: number;
  text: string;
  duplicate?: boolean; // 重複の印。付いた発言は差分更新に使わない
};

// ルートの ID はいつも ROOT_ID
export type DiffInput = {
  map: MeetingMap;
  recent: Remark[]; // 直前に処理済みの発言（文脈用）
  fresh: Remark[]; // 新しい発言
};
export type DiffOutput = { ops: Op[] };
export type DiffUpdater = (input: DiffInput) => Promise<DiffOutput>;

export type LogEvent =
  | { type: "remark"; remark: Remark }
  // input は入力の要約: 渡した発言の ID と、呼び出した時点のノード数（ルートを除く）
  | { type: "diff"; input: { recent: string[]; fresh: string[]; nodeCount: number }; ops: Op[]; dropped: Dropped[]; error?: string };

// 論点の状態は保存していないので、スナップショットを作るときに導いて載せる
export type SnapshotNode = MapNode & { pointStatus?: PointStatus };
export type Snapshot = { nodes: SnapshotNode[] };

export type SessionOptions = { title: string; updater: DiffUpdater; log: (event: LogEvent) => void };

const BATCH = 2;
const RECENT = 3;

export function createSession({ title, updater, log }: SessionOptions) {
  let map = emptyMap(title);
  let pending: Remark[] = [];
  let processed: Remark[] = [];
  const remarks: Remark[] = []; // 受け取ったすべての発言（重複の印つきも含む）
  const known = new Set<string>(); // 差分更新に渡した発言の ID
  let inFlight: Promise<void> | null = null;

  // 呼び出し中でなく、発言が min 以上たまっていれば、たまった分をまとめて差分更新に渡す。
  // 呼び出しの後に 1 つしか残っていなくても、2 つ目を待つ（試作 v3 で確かめた入力の形に揃える）。
  function startDiffIfReady(min = BATCH) {
    if (inFlight || pending.length < min) return;
    const fresh = pending;
    pending = [];
    inFlight = callUpdater(fresh).finally(() => {
      inFlight = null;
      startDiffIfReady();
    });
  }

  async function callUpdater(fresh: Remark[]) {
    const recent = processed.slice(-RECENT);
    for (const u of fresh) known.add(u.id);
    const input = { recent: recent.map((u) => u.id), fresh: fresh.map((u) => u.id), nodeCount: map.order.length - 1 };
    processed = [...processed, ...fresh];
    let ops: Op[];
    try {
      ({ ops } = await updater({ map, recent, fresh }));
    } catch (e) {
      // 失敗した回の発言は処理済みとして扱い、マップは変えずに次へ進む
      log({ type: "diff", input, ops: [], dropped: [], error: String(e) });
      return;
    }
    const applied = applyOps(map, ops, known);
    map = applied.map;
    log({ type: "diff", input, ops, dropped: applied.dropped });
  }

  function snapshot(): Snapshot {
    const nodes = map.order.map((id): SnapshotNode => {
      const n = cloneNode(map.nodes[id]!);
      return n.kind === "論点" ? { ...n, pointStatus: pointStatus(map, id) } : n;
    });
    return { nodes };
  }

  return {
    push(r: Remark) {
      remarks.push(r);
      log({ type: "remark", remark: r });
      if (r.duplicate) return;
      pending.push(r);
      startDiffIfReady();
    },
    // 呼び出し中のものと、それに続けて起きた呼び出しがすべて終わるまで待つ
    async idle() {
      while (inFlight) await inFlight;
    },
    // 終わりに、2 つに満たず残った発言も流す（最後の発言を取りこぼさない）
    async flush() {
      await this.idle();
      startDiffIfReady(1);
      await this.idle();
    },
    snapshot,
    // その時点のマップのエクスポート（JSON）
    exportJson(): JsonExport {
      return toJsonExport(snapshot(), remarks);
    },
  };
}

export type Session = ReturnType<typeof createSession>;
