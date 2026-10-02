// セッション: 発言の流れを受け、差分更新を呼んでマップを組み立てる。
// WebSocket・CLI・Node の実行環境に依存しない（ADR 0003）。ログの書き先は外から渡す。
import { diffMaps, type Change } from "./changes.ts";
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
// 変わったこと（反映の履歴）。round は成功した反映の通し番号、at は反映に渡した新しい発言の end の最大値（会議の中の秒）。
export type ChangeEntry = Change & { round: number; at: number };
// remarks は、いまのノードの根拠に挙がっている発言だけ（受け取った順・重複なし）。evidence の ID から引く。
export type Snapshot = { nodes: SnapshotNode[]; round: number; changes: ChangeEntry[]; remarks: Remark[] };

export type SessionOptions = {
  title: string;
  updater: DiffUpdater;
  log: (event: LogEvent) => void;
  // 待ち方。渡すと、最後の発言から QUIET_MS 新しい発言が来ないとき、1 つだけたまっていてもその 1 つで差分更新を呼ぶ。
  // 渡さなければ待たない（playback の sleep と同じ形。中核は実行環境のタイマーを使わない）
  sleep?: (ms: number) => Promise<void>;
};

const BATCH = 2;
export const QUIET_MS = 5000; // 最後の発言からこの時間、次の発言が来なければ、1 つでも差分更新を呼ぶ
const RECENT = 3;

type SessionState = {
  map: MeetingMap;
  pending: Remark[]; // 差分更新にまだ渡していない発言
  processed: Remark[]; // 差分更新に渡した発言
  remarks: Remark[]; // 受け取ったすべての発言（重複の印つきも含む）
  known: Set<string>; // 差分更新に渡した発言の ID
  round: number; // 成功した反映の通し番号
  changes: ChangeEntry[]; // 反映ごとに積む、変わったことの履歴
};

// 成功した反映を 1 回記録する。変化がなくても round は進める（前回の赤い枠を消すため）。
// ライブ（callUpdater）と復元（restoreSession）が同じ関数を通す。
function recordRound(state: Pick<SessionState, "round" | "changes">, before: MeetingMap, after: MeetingMap, fresh: Remark[]) {
  state.round += 1;
  const at = Math.max(...fresh.map((r) => r.end));
  for (const c of diffMaps(before, after)) state.changes.push({ ...c, round: state.round, at });
}

export function createSession({ title, updater, log, sleep }: SessionOptions) {
  log({ type: "start", title });
  return openSession(
    { map: emptyMap(title), pending: [], processed: [], remarks: [], known: new Set(), round: 0, changes: [] },
    { updater, log, sleep },
  );
}

// ログのイベントを順に適用関数へ流して、セッションを元の状態に戻す。
// 差分更新は呼ばず、イベントも log し直さない。知らない種類のイベントは読み飛ばす。
export function restoreSession(events: Iterable<unknown>, options: Omit<SessionOptions, "title">): Session {
  let map: MeetingMap | undefined;
  const remarks: Remark[] = [];
  const processed: Remark[] = [];
  const known = new Set<string>();
  const history = { round: 0, changes: [] as ChangeEntry[] };
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
        const fresh: Remark[] = [];
        for (const id of e.input.fresh) {
          const r = remarks.find((x) => x.id === id);
          if (!r) throw new Error(`ログに発言がありません: ${id}`);
          known.add(id);
          processed.push(r);
          fresh.push(r);
        }
        const next = applyOps(map, e.ops, known).map;
        if (e.error === undefined) recordRound(history, map, next, fresh);
        map = next;
        break;
      }
    }
  }
  if (!map) throw new Error("ログに start がありません");
  const pending = remarks.filter((r) => !r.duplicate && !known.has(r.id));
  return openSession({ map, pending, processed, remarks, known, ...history }, options);
}

function openSession(state: SessionState, { updater, log, sleep }: Omit<SessionOptions, "title">) {
  let { map, pending, processed } = state;
  const { remarks, known } = state;
  let inFlight: Promise<void> | null = null;
  let gen = 0; // 新しい発言を受け取るたびに進める。古い待ちの解決を無視するための世代
  let quiet = false; // 最後の発言から QUIET_MS 経った。呼び出し中に経った場合も、終わった時点で 1 つで流す
  let reflecting: Remark[] = []; // 差分更新の結果待ちの発言。結果を log する直前に外す

  // 呼び出し中でなく、発言が min 以上たまっていれば、たまった分をまとめて差分更新に渡す。
  // 呼び出しの後に 1 つしか残っていなくても、QUIET_MS 経つまでは 2 つ目を待つ（試作 v3 で確かめた入力の形に揃える）。
  function startDiffIfReady(min = BATCH) {
    if (inFlight || pending.length < min) return;
    const fresh = pending;
    pending = [];
    inFlight = callUpdater(fresh).finally(() => {
      inFlight = null;
      startDiffIfReady(quiet ? 1 : BATCH);
    });
  }

  // 最後の発言から QUIET_MS 新しい発言が来なければ、たまった分で差分更新を呼ぶ。
  // sleep は取り消せないので、世代が変わっていたら（その後に発言が来ていたら）何もしない。
  function waitForQuiet() {
    if (!sleep) return;
    const g = gen;
    void sleep(QUIET_MS).then(() => {
      if (g !== gen) return;
      quiet = true;
      startDiffIfReady(1);
    });
  }

  async function callUpdater(fresh: Remark[]) {
    const recent = processed.slice(-RECENT);
    for (const u of fresh) known.add(u.id);
    const input = { recent: recent.map((u) => u.id), fresh: fresh.map((u) => u.id), nodeCount: map.order.length - 1 };
    processed = [...processed, ...fresh];
    reflecting = fresh;
    let ops: Op[];
    try {
      ({ ops } = await updater({ map, recent, fresh }));
    } catch (e) {
      // 失敗した回の発言は処理済みとして扱い、マップは変えずに次へ進む
      reflecting = [];
      log({ type: "diff", input, ops: [], dropped: [], error: String(e) });
      return;
    }
    const applied = applyOps(map, ops, known);
    // 送信（log）より先に記録する。log の中で届くスナップショットに今回分が載る
    recordRound(state, map, applied.map, fresh);
    map = applied.map;
    reflecting = [];
    log({ type: "diff", input, ops, dropped: applied.dropped });
  }

  function snapshot(): Snapshot {
    const nodes = map.order.map((id): SnapshotNode => {
      const n = cloneNode(map.nodes[id]!);
      return n.kind === "論点" ? { ...n, pointStatus: pointStatus(map, id) } : n;
    });
    const cited = new Set(nodes.flatMap((n) => n.evidence));
    return {
      nodes,
      round: state.round,
      changes: state.changes.map((c) => ({ ...c })),
      remarks: remarks.filter((r) => cited.has(r.id)).map((r) => ({ ...r })),
    };
  }

  return {
    push(r: Remark) {
      remarks.push(r);
      log({ type: "remark", remark: r });
      if (r.duplicate) return;
      pending.push(r);
      gen += 1;
      quiet = false;
      startDiffIfReady();
      if (pending.length > 0) waitForQuiet();
    },
    // 呼び出し中のものと、それに続けて起きた呼び出しがすべて終わるまで待つ
    async idle() {
      while (inFlight) await inFlight;
    },
    // 終わりに、2 つに満たず待ちも切れていない発言も流す（最後の発言を取りこぼさない）
    async flush() {
      await this.idle();
      startDiffIfReady(1);
      await this.idle();
    },
    snapshot,
    // まだマップに反映していない発言（差分更新の結果待ち + 渡していないもの）。仮のノードの文字に使う。重複の印つきは含まない
    unreflectedRemarks(): Remark[] {
      return [...reflecting, ...pending].map((r) => ({ ...r }));
    },
    // その時点のマップのエクスポート（JSON）
    exportJson(): JsonExport {
      return toJsonExport(snapshot(), remarks);
    },
  };
}

export type Session = ReturnType<typeof openSession>;
