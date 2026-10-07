import { Slider } from "@videojs/react";
import { PauseIcon, PlayIcon } from "@videojs/react/icons";
import { formatHms } from "./reviewTimeline.ts";

// 見返しのシークバーと操作の行。状態は持たず、渡された時刻と出来事の送り先だけで描く。
// シークバーは会議の時刻の軸で全幅に置き、操作の行はその下に置く（マップには重ねない）。
type Props = {
  time: number;
  duration: number;
  playing: boolean;
  topicName: string;
  onSeek: (time: number) => void;
  onToggle: () => void;
  onPrev: () => void;
  onNext: () => void;
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

export function ReviewControls({ time, duration, playing, topicName, onSeek, onToggle, onPrev, onNext }: Props) {
  return (
    <div className="review-controls">
      <Slider.Root className="review-seek" min={0} max={duration} value={time} onValueChange={onSeek} onDragEnd={releaseFocus} onPointerUp={releaseFocus} label="時刻">
        <Slider.Track className="review-seek__track">
          <Slider.Fill className="review-seek__fill" />
        </Slider.Track>
        <Slider.Thumb className="review-seek__thumb" />
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
      </div>
    </div>
  );
}
