// セッション: 発言の流れを受け、差分更新を呼んでマップを組み立てる。
// WebSocket・CLI・Node の実行環境に依存しない（ADR 0003）。ログの書き先は外から渡す。
import { Schema } from "effect";
import { diffMaps, type Change } from "./changes.ts";
import { toJsonExport, type JsonExport } from "./export.ts";
import { applyOps, cloneNode, Dropped, emptyMap, Op, pointStatus, type DiffOutput, type MapNode, type MeetingMap, type PointStatus } from "./map.ts";
import { lastChangedNode, nextCurrentTopic } from "./topic.ts";

export const Track = Schema.Literals(["自分", "相手"]);
export type Track = typeof Track["Type"];

// 発言（GLOSSARY.md）
export const Remark = Schema.Struct({
  id: Schema.String,
  track: Track,
  start: Schema.Number, // 会議の中の秒
  end: Schema.Number,
  text: Schema.mutableKey(Schema.String),
  duplicate: Schema.optionalKey(Schema.Boolean), // 重複の印。付いた発言は差分更新に使わない
});
export type Remark = typeof Remark["Type"];

// ルートの ID はいつも ROOT_ID
export type DiffInput = {
  map: MeetingMap;
  recent: Remark[]; // 直前に処理済みの発言（文脈用）
  fresh: Remark[]; // 新しい発言
};
export type DiffUpdater = (input: DiffInput) => Promise<DiffOutput>;

// ログの行の形。段 6 でここから読み込みを検証する。
// cli.ts が `{ at, ...event }` で書くので、余分なキーは厳格にしない（保存済みのログを読めなくしない）
export const LogEvent = Schema.Union([
  // セッションの始まり。ルートの本文（タイトル）を残す
  Schema.Struct({ type: Schema.Literal("start"), title: Schema.String }),
  // noContent は、中身のない発言（hasContent が false）として差分更新・未反映の発言から外したことの印。ログにだけ付く
  Schema.Struct({ type: Schema.Literal("remark"), remark: Remark, noContent: Schema.optionalKey(Schema.Literal(true)) }),
  Schema.Struct({
    type: Schema.Literal("diff"),
    // input は入力の要約: 渡した発言の ID と、呼び出した時点のノード数（ルートを除く）
    input: Schema.Struct({
      recent: Schema.mutable(Schema.Array(Schema.String)),
      fresh: Schema.mutable(Schema.Array(Schema.String)),
      nodeCount: Schema.Number,
    }),
    ops: Schema.mutable(Schema.Array(Op)),
    dropped: Schema.mutable(Schema.Array(Dropped)),
    error: Schema.optionalKey(Schema.String),
  }),
]);
export type LogEvent = typeof LogEvent["Type"];

// 論点の状態は保存していないので、スナップショットを作るときに導いて載せる
export type SnapshotNode = MapNode & { pointStatus?: PointStatus };
// 変わったこと（反映の履歴）。round は成功した反映の通し番号、at は反映に渡した新しい発言の end の最大値（会議の中の秒）。
export type ChangeEntry = Change & { round: number; at: number };
// remarks は、いまのノードの根拠に挙がっている発言だけ（受け取った順・重複なし）。evidence の ID から引く。
// currentTopic は今の議題の ID（まだ無ければキーごと付けない）。now は会議の今の時刻（最後に受け取った発言の end。発言が無ければキーごと付けない）。
export type Snapshot = {
  nodes: SnapshotNode[];
  round: number;
  changes: ChangeEntry[];
  remarks: Remark[];
  currentTopic?: string;
  lastChanged?: string; // 今の round で最後に変わったノードの ID（変わったノードが無ければキーごと付けない）
  now?: number;
};

export type SessionOptions = {
  title: string;
  updater: DiffUpdater;
  log: (event: LogEvent) => void;
  // 待ち方。渡すと、最後の発言から QUIET_MS 新しい発言が来ないとき、1 つだけたまっていてもその 1 つで差分更新を呼ぶ。
  // 渡さなければ待たない（playback の sleep と同じ形。中核は実行環境のタイマーを使わない）
  sleep?: (ms: number) => Promise<void>;
};

const BATCH = 2;
export const QUIET_MS = 1500; // 最後の発言からこの時間、次の発言が来なければ、1 つでも差分更新を呼ぶ
const RECENT = 3;

// 中身のない発言の判定に使うフィラー（長音 ー〜~ を除いた形）。確定した発言の語がこれだけなら中身なしとする
export const FILLERS: ReadonlySet<string> = new Set([
  "あ", "え", "う", "お", "ん", "うん", "ふん", "ええ", "はあ", "へえ", "ほう",
  "あの", "えっと", "えと", "その", "まあ", "はい",
]);

// 発言が差分更新に渡す中身を持つか。空白・句読点で語に分け、長音を除いた各語がすべてフィラーなら false。
// 文字数では判定しない（「賛成」は渡す）。前方一致でもない（「はい。では…」は渡す）
export function hasContent(text: string): boolean {
  const words = text.replace(/[ー〜~]/g, "").split(/[\s\p{P}\p{S}]+/u).filter((w) => w !== "");
  return words.some((w) => !FILLERS.has(w));
}

type SessionState = {
  map: MeetingMap;
  pending: Remark[]; // 差分更新にまだ渡していない発言
  processed: Remark[]; // 差分更新に渡した、中身のある発言
  remarks: Remark[]; // 受け取ったすべての発言（重複の印つきも含む）
  known: Set<string>; // 差分更新に渡した発言の ID
  round: number; // 成功した反映の通し番号
  changes: ChangeEntry[]; // 反映ごとに積む、変わったことの履歴
  currentTopic: string | undefined; // 今の議題の ID。変わったノードのある反映で更新する
  lastChanged: string | undefined; // 直近の反映で最後に変わったノードの ID。変わったノードが無ければ undefined
};

// 成功した反映を 1 回記録する。変化がなくても round は進める（前回の赤い枠を消すため）。
// ライブ（callUpdater）と復元（restoreSession）が同じ関数を通す。
function recordRound(state: Pick<SessionState, "round" | "changes" | "currentTopic" | "lastChanged">, before: MeetingMap, applied: { map: MeetingMap; changeOrder: string[] }, fresh: Remark[]) {
  state.round += 1;
  const at = Math.max(...fresh.map((r) => r.end));
  const changes = diffMaps(before, applied.map);
  for (const c of changes) state.changes.push({ ...c, round: state.round, at });
  // 最後に変わったノードは一度だけ選び、今の議題と lastChanged の両方をそこから作る
  const lastChanged = lastChangedNode(applied.map, applied.changeOrder);
  state.lastChanged = lastChanged;
  state.currentTopic = nextCurrentTopic(applied.map, lastChanged, state.currentTopic);
}

export function createSession({ title, updater, log, sleep }: SessionOptions) {
  log({ type: "start", title });
  return openSession(
    { map: emptyMap(title), pending: [], processed: [], remarks: [], known: new Set(), round: 0, changes: [], currentTopic: undefined, lastChanged: undefined },
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
  const history = { round: 0, changes: [] as ChangeEntry[], currentTopic: undefined as string | undefined, lastChanged: undefined as string | undefined };
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
          if (hasContent(r.text)) processed.push(r); // 旧形式のログの中身のない発言は、続きの差分更新の直前の発言にしない
          fresh.push(r);
        }
        const applied = applyOps(map, e.ops, known);
        if (e.error === undefined) recordRound(history, map, applied, fresh);
        map = applied.map;
        break;
      }
    }
  }
  if (!map) throw new Error("ログに start がありません");
  const pending = remarks.filter((r) => !r.duplicate && !known.has(r.id) && hasContent(r.text));
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
    recordRound(state, map, applied, fresh);
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
    const last = remarks.at(-1);
    return {
      nodes,
      round: state.round,
      changes: state.changes.map((c) => ({ ...c })),
      remarks: remarks.filter((r) => cited.has(r.id)).map((r) => ({ ...r })),
      ...(state.currentTopic !== undefined ? { currentTopic: state.currentTopic } : {}),
      ...(state.lastChanged !== undefined ? { lastChanged: state.lastChanged } : {}),
      ...(last ? { now: last.end } : {}),
    };
  }

  return {
    push(r: Remark) {
      remarks.push(r);
      if (!r.duplicate && !hasContent(r.text)) {
        // 中身のない発言: ログには残すが、差分更新・未反映の発言・待ち時間には関わらせない
        log({ type: "remark", remark: r, noContent: true });
        return;
      }
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
    // まだマップに反映していない発言（差分更新の結果待ち + 渡していないもの）。仮のノードの文字に使う。重複の印つき・中身のない発言は含まない
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
