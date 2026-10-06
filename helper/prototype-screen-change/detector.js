// PROTOTYPE（使い捨て、issue #252）: 共有画面の「中身が変わった」の判定。DOM に触れない純粋な関数。
// file:// で開けるよう、ふつうの script として読む。
// 1 フレームずつ step() に渡すと、送る出来事（screen = 新しい画面、none = 共有画面が無い）を返す。
// frame: { t: 秒, sig: Uint8Array(128*72) の輝度, title: ウィンドウのタイトル }
//
// 考え方: 128×72 のマス（1280 幅のウィンドウで約 10px 四方）ごとに、最後に送った画面と比べる。ただし次の 2 種類のマスは比べない。
//   - いま動いているマス（直近 hold 秒に動いた、または直近 busyTau 秒のうち busy の割合以上で動いていた）:
//     顔・動画・スクロール中・カーソル。外すのは一時的で、止まれば送った画面との差として拾う（見落とさず、遅れるだけ）
// 比べたマスのうち content % 以上が違えば、新しい画面として送る。映り始めた時刻は、それらのマスが今の値になった時刻。
// ただし、違うマスがどれも直近に送った画面のどれかと同じ値で、範囲が狭い（wide % 未満）なら送らない
// （話している人の枠が移っただけ）。広い範囲が前の画面に戻る（前のスライドに戻る）のは送る。

const DEFAULTS = {
  pixel: 10,        // 送った画面と比べて、1 マス（約 10px 四方の平均）の輝度がこれより違えば「違うマス」
  movePixel: 3,     // 前のフレームとこれより違えば「動いた」（ゆっくり動く顔を拾えるよう低め）
  margin: 2,        // 広く動いている場所の周り何マスまで比べるのから外すか（顔の縁の揺れ）
  wideMove: 8,      // 周り 5×5 のうち動いているマスがこれ以上なら「広く動いている」
  hold: 1.0,        // 最後に動いてからこの秒数は「いま動いている」とみなす（= 止まってから送るまでの待ち）
  content: 0.5,     // 比べたマスのこの % 以上が違えば、中身が変わったとみなす
  busyTau: 10,      // よく動く場所を見る時間の幅（秒）
  busy: 0.25,       // その間に動いたフレームの割合がこれを超えたマスは「いま動いている」に含める
  burst: 3,         // 動き出しがこの秒数より近ければ、ひと続きの動き（打鍵・スクロール）として 1 回に数える
  history: 30,      // 「前に送った画面と同じ」を見るのに覚えておく枚数（0 で使わない）
  recurPixel: 6,    // 前に送った画面と「同じ」とみなす輝度の差
  wide: 10,         // 違うマスが全体のこの % 以上なら、前に送った画面と同じでも送る（前のスライドに戻った）
  movingOnly: 70,   // いま動いているマスが全体のこの % を超えた状態が movingFor 秒続いたら「顔か動画だけ」とみなす（0 で使わない）
  movingFor: 3,
  maxWait: 0,       // 動きが続いても、この秒数ごとに今の画面を送る（0 で送らない）
  titleMatch: "Meet", // タイトルにこれを含まなければ会議ではない画面（別のタブ）とみなし「なし」にする（空で使わない）
};

function createDetector(params = {}) {
  const p = { ...DEFAULTS, ...params };
  const W = p.W ?? 128, H = p.H ?? 72, N = W * H; // record の縮小画像の大きさ
  const s = {
    prev: null, sent: null, mode: "start", lastSentT: -1e9, prevT: 0,
    lastMoved: new Float64Array(N).fill(-1e9), // そのマスが最後に動いた時刻
    moveStart: new Float64Array(N).fill(-1e9), // ひと続きの動きが始まった時刻
    past: [], manySince: null, // 前に送った画面（新しい順）
    act: new Float32Array(N),  // 動いたフレームの割合（busyTau の指数移動平均）
    ref: new Uint8Array(N), refSince: new Float64Array(N), // 今の値になった時刻（ref から pixel を超えて変わるたびに更新）
  };
  const reset = () => { s.prev = null; s.sent = null; s.lastMoved.fill(-1e9); s.moveStart.fill(-1e9); s.act.fill(0); };

  function step(f) {
    const out = [], metrics = { change: 0, moving: 0, recur: 0 };
    if (p.titleMatch && !f.title.includes(p.titleMatch)) {
      if (s.mode !== "none") out.push({ type: "none", t: f.t, reason: "会議ではない画面（タイトル）" });
      s.mode = "none"; reset(); s.prevT = f.t;
      return { events: out, metrics };
    }
    const a = Math.min(1, Math.max(0, f.t - s.prevT) / p.busyTau);
    if (s.prev) for (let i = 0; i < N; i++) {
      const moved = Math.abs(f.sig[i] - s.prev[i]) > p.movePixel;
      s.act[i] = s.act[i] * (1 - a) + (moved ? a : 0);
      if (!moved) continue;
      if (f.t - s.lastMoved[i] > p.burst) s.moveStart[i] = f.t; // 新しいひと続きの動き
      s.lastMoved[i] = f.t;
    }
    for (let i = 0; i < N; i++) if (!s.prev || Math.abs(f.sig[i] - s.ref[i]) > p.pixel) { s.ref[i] = f.sig[i]; s.refSince[i] = f.t; }
    // 比べないマス: いま動いている（周り margin マスも）
    const mv = new Uint8Array(N); let nMoving = 0;
    for (let i = 0; i < N; i++) if (f.t - s.lastMoved[i] < p.hold || s.act[i] > p.busy) { mv[i] = 1; nMoving++; }
    const skip = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      if (!mv[i]) continue;
      const x = i % W, y = (i / W) | 0;
      // 広く動いている場所（顔・動画）は margin マス、点のように小さく動くもの（キャレット・カーソル）は 1 マスだけ外す
      let around = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && xx < W && yy >= 0 && yy < H && mv[yy * W + xx]) around++;
      }
      const m = around >= p.wideMove ? p.margin : 1;
      for (let dy = -m; dy <= m; dy++) for (let dx = -m; dx <= m; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && xx < W && yy >= 0 && yy < H) skip[yy * W + xx] = 1;
      }
    }
    metrics.moving = (nMoving / N) * 100;

    s.manySince = p.movingOnly && metrics.moving > p.movingOnly ? s.manySince ?? f.t : null;
    if (s.manySince !== null && f.t - s.manySince >= p.movingFor) {
      if (s.mode !== "none") out.push({ type: "none", t: f.t, reason: "顔か動画だけ（動いているマスが多い）" });
      s.mode = "none"; s.sent = null;
    } else if (!s.sent) {
      // 最初の 1 枚、または「なし」の後: 動いている部分が半分を切ったら送る
      if (s.prev && metrics.moving < 50) send(f, f.t, "最初の画面", out);
    } else {
      let n = 0; const diff = [];
      for (let i = 0; i < N; i++) {
        if (skip[i]) continue;
        n++;
        if (Math.abs(f.sig[i] - s.sent[i]) > p.pixel) diff.push(i);
      }
      metrics.change = n ? (diff.length / n) * 100 : 0;
      // 違うマスが、前に送った画面のどれか 1 枚とそろって同じ値か（話している人の枠が移っただけ）
      const same = (g) => diff.every((i) => Math.abs(f.sig[i] - g[i]) <= p.recurPixel);
      metrics.recur = diff.length && s.past.some(same) ? 1 : 0;
      const isWide = (diff.length / N) * 100 >= p.wide;
      if (metrics.change >= p.content && (isWide || !metrics.recur)) {
        // 映り始めた時刻: 違うマスが今の値になった時刻の中央値（前に送った時刻より前にはしない）
        const since = diff.map((i) => s.refSince[i]).sort((a, b) => a - b);
        send(f, Math.max(s.lastSentT, since[since.length >> 1]), isWide && metrics.recur ? "前の画面に戻った" : "止まった", out);
      }
      else if (p.maxWait && f.t - s.lastSentT >= p.maxWait && metrics.moving > 5) send(f, f.t, "動き続けているので今を送る", out);
    }
    s.prev = f.sig; s.prevT = f.t;
    return { events: out, metrics };
  }
  function send(f, start, why, out) {
    out.push({ type: "screen", t: start, at: f.t, why, thumb: f.thumb });
    if (s.sent) { s.past.unshift(s.sent); s.past.length = Math.min(s.past.length, p.history); }
    s.sent = f.sig; s.lastSentT = f.t; s.mode = "showing";
  }
  return { step };
}
