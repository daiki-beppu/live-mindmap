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
  | { type: "start"; title: string } // セッションの始まり。ルートの本文（タイトル）を残す
  | { type: "remark"; remark: Remark }
  // input は入力の要約: 渡した発言の ID と、呼び出した時点のノード数（ルートを除く）
  | { type: "diff"; input: { recent: string[]; fresh: string[]; nodeCount: number }; ops: Op[]; dropped: Dropped[]; error?: string };

// 論点の状態は保存していないので、スナップショットを作るときに導いて載せる
export type SnapshotNode = MapNode & { pointStatus?: PointStatus };
export type Snapshot = { nodes: SnapshotNode[] };

export type SessionOptions = { title: string; updater: DiffUpdater; log: (event: LogEvent) => void };

const BATCH = 2;
const RECENT = 3;

type SessionState = {
  map: MeetingMap;
  pending: Remark[]; // 差分更新にまだ渡していない発言
  processed: Remark[]; // 差分更新に渡した発言
  remarks: Remark[]; // 受け取ったすべての発言（重複の印つきも含む）
  known: Set<string>; // 差分更新に渡した発言の ID
};

export function createSession({ title, updater, log }: SessionOptions) {
  log({ type: "start", title });
  return openSession({ map: emptyMap(title), pending: [], processed: [], remarks: [], known: new Set() }, { updater, log });
}

// ログのイベントを順に適用関数へ流して、セッションを元の状態に戻す。
// 差分更新は呼ばず、イベントも log し直さない。知らない種類のイベントは読み飛ばす。
export function restoreSession(events: Iterable<unknown>, options: Omit<SessionOptions, "title">): Session {
  let map: MeetingMap | undefined;
  const remarks: Remark[] = [];
  const processed: Remark[] = [];
  const known = new Set<string>();
  for (const event of events) {
    const e = event as LogEvent;
    switch (e.type) {
      case "start":
        map = emptyMap(e.title);
        break;
      case "remark":
        remarks.push(e.remark);
        break;
      case "diff": {
        if (!map) throw new Error("ログの diff より前に start がありません");
        for (const id of e.input.fresh) {
          const r = remarks.find((x) => x.id === id);
          if (!r) throw new Error(`ログに発言がありません: ${id}`);
          known.add(id);
          processed.push(r);
        }
        map = applyOps(map, e.ops, known).map;
        break;
      }
    }
  }
  if (!map) throw new Error("ログに start がありません");
  const pending = remarks.filter((r) => !r.duplicate && !known.has(r.id));
  return openSession({ map, pending, processed, remarks, known }, options);
}

function openSession(state: SessionState, { updater, log }: Omit<SessionOptions, "title">) {
  let { map, pending, processed } = state;
  const { remarks, known } = state;
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

export type Session = ReturnType<typeof openSession>;
