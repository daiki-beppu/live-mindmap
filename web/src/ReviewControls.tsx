import { Slider } from "@videojs/react";
import { CheckIcon, PauseIcon, PlayIcon, SpeedIcon } from "@videojs/react/icons";
import { useEffect, useRef, useState } from "react";
import { KIND_COLOR } from "./kinds.ts";
import { chapterNameAt, formatHms, type Chapter, type Mark } from "./reviewTimeline.ts";

// 見返しのシークバーと操作の行。状態は持たず、渡された時刻と出来事の送り先だけで描く。
// シークバーは会議の時刻の軸で全幅に置き、操作の行はその下に置く（マップには重ねない）。
type Props = {
  time: number;
  duration: number;
  playing: boolean;
  rate: number;
  rates: readonly number[];
  topicName: string;
  chapters: readonly Chapter[];
  marks: readonly Mark[];
  onSeek: (time: number) => void;
  onToggle: () => void;
  onPrev: () => void;
  onNext: () => void;
  onRate: (rate: number) => void;
};

// 押して離したら（クリックでもドラッグでも）、シークバーからフォーカスを外す（矢印キーなどの操作がシークバーに奪われたままにならないように）
const releaseFocus = () => {
  const active = document.activeElement;
  if (active instanceof HTMLElement) active.blur();
};

const StepIcon = ({ direction }: { direction: "prev" | "next" }) => (
  <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="currentColor">
    {direction === "prev" ? <path d="M3 3h2v10H3zM13 3v10L6 8z" /> : <path d="M11 3h2v10h-2zM3 3l7 5-7 5z" />}
  </svg>
);

// メニューの項目の文言。例: 「60 倍（161 分を 2.7 分で）」
export const rateOptionLabel = (rate: number, duration: number) => `${rate} 倍（${Math.round(duration / 60)} 分を ${(Math.round((duration / rate / 60) * 10) / 10).toFixed(1)} 分で）`;

// 速さのボタンとメニュー。開閉だけを局所で持つ。開いている間の Esc は、SessionView の Esc より先に（capture 段階で）受けて閉じる
function RateMenu({ duration, rate, rates, onRate }: Pick<Props, "duration" | "rate" | "rates" | "onRate">) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
    };
    const onPointerDown = (e: PointerEvent) => {
      if (!(e.target instanceof Node) || !root.current?.contains(e.target)) setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);
  return (
    <div className="review-rate" ref={root}>
      <button type="button" className="review-bar__button review-rate__button" aria-label="再生の速さ" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <SpeedIcon />
        <span>{rate}×</span>
      </button>
      {open && (
        <div className="review-rate__menu" role="menu" aria-label="再生の速さ">
          {rates.map((r) => (
            <button
              key={r}
              type="button"
              role="menuitemradio"
              aria-checked={r === rate}
              className="review-rate__item"
              onClick={() => {
                onRate(r);
                setOpen(false);
                releaseFocus();
              }}
            >
              <span className="review-rate__check">{r === rate && <CheckIcon />}</span>
              {rateOptionLabel(r, duration)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function ReviewControls({ time, duration, playing, rate, rates, topicName, chapters, marks, onSeek, onToggle, onPrev, onNext, onRate }: Props) {
  // 章が無い、または会議の長さが 0 のときは、区切らずに全幅の 1 本で描く（0 での割り算を避ける）
  const segments: readonly Chapter[] = chapters.length > 0 && duration > 0 ? chapters : [{ topic: "", name: "", start: 0, end: duration }];
  return (
    <div className="review-controls">
      <Slider.Root className="review-seek" min={0} max={duration} value={time} onValueChange={onSeek} onDragEnd={releaseFocus} onPointerUp={releaseFocus} label="時刻">
        <Slider.Track className="review-seek__track">
          {segments.map((c) => {
            const len = c.end - c.start;
            const whole = chapters.length === 0 || duration <= 0;
            const filled = whole ? (duration > 0 ? Math.min(1, time / duration) : 0) : len > 0 ? Math.min(1, Math.max(0, (time - c.start) / len)) : 0;
            return (
              <div key={c.start} className="review-seek__chapter" style={whole ? { left: 0, width: "100%" } : { left: `${(c.start / duration) * 100}%`, width: `calc(${(len / duration) * 100}% - 2px)` }}>
                <div className="review-seek__progress" style={{ width: `${filled * 100}%` }} />
              </div>
            );
          })}
          {duration > 0 && marks.map((m, i) => <span key={i} className="review-seek__mark" style={{ left: `${(m.at / duration) * 100}%`, background: KIND_COLOR[m.kind] }} />)}
        </Slider.Track>
        <Slider.Thumb className="review-seek__thumb" />
        <Slider.Preview className="review-seek__preview">
          <Slider.Value type="pointer" className="review-seek__preview-chapter" format={(v) => chapterNameAt(chapters, v)} />
          <Slider.Value type="pointer" className="review-seek__preview-time" format={formatHms} />
        </Slider.Preview>
      </Slider.Root>
      <div className="review-bar">
        <button type="button" className="review-bar__button" aria-label="反映 1 つ戻る" onClick={onPrev}>
          <StepIcon direction="prev" />
        </button>
        <button type="button" className="review-bar__button" aria-label={playing ? "止める" : "再生"} onClick={onToggle}>
          {playing ? <PauseIcon /> : <PlayIcon />}
        </button>
        <button type="button" className="review-bar__button" aria-label="反映 1 つ進む" onClick={onNext}>
          <StepIcon direction="next" />
        </button>
        <span className="review-bar__time">
          {formatHms(time)} / {formatHms(duration)}
        </span>
        <span className="review-bar__topic">{topicName}</span>
        {rates.length > 1 && <RateMenu duration={duration} rate={rate} rates={rates} onRate={onRate} />}
      </div>
    </div>
  );
}
