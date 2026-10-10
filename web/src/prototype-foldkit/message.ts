// 試作（Issue #736）: Foldkit 版の見返しの画面が受ける Message。DOM の生のイベントは Mount・Subscription で数値に直してから入れる
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";
import { Slider } from "@foldkit/ui";

const Mods = { meta: Schema.Boolean, ctrl: Schema.Boolean, alt: Schema.Boolean };
const Dims = Schema.Record(Schema.String, Schema.Struct({ width: Schema.Number, height: Schema.Number }));

export const ViewKey = Schema.Literals(["=", "-", "0", "F", "Z", "Shift+ArrowLeft", "Shift+ArrowRight", "Shift+ArrowUp", "Shift+ArrowDown"]);
export const ReviewAction = Schema.Literals(["toggle", "back", "forward", "prev", "next", "slower", "faster", "start", "end", "mute"]);

export const Message = defineMessageUnion({
  // マップの表示面（Mount と文書の pointer の Subscription から）
  MeasuredNodes: { dims: Dims },
  ResizedMap: { width: Schema.Number, height: Schema.Number },
  Wheeled: { dx: Schema.Number, dy: Schema.Number, deltaMode: Schema.Number, shift: Schema.Boolean, x: Schema.Number, y: Schema.Number, at: Schema.Number, ...Mods },
  Gestured: { ratio: Schema.Number, x: Schema.Number, y: Schema.Number },
  ModClicked: { x: Schema.Number, y: Schema.Number, alt: Schema.Boolean },
  PressedPane: { x: Schema.Number, y: Schema.Number },
  PressedNode: { id: Schema.String, x: Schema.Number, y: Schema.Number },
  ReleasedNode: { id: Schema.String, x: Schema.Number, y: Schema.Number },
  MovedPointer: { x: Schema.Number, y: Schema.Number },
  ReleasedPointer: {},
  ClickedNode: { id: Schema.String },
  ClickedFoldDot: { id: Schema.String },
  ClickedEdgeDot: { id: Schema.String },
  ClickedChange: { id: Schema.String },
  TickedFrame: { dt: Schema.Number },
  Idled: {},
  // キー（#153）
  PressedViewKey: { key: ViewKey },
  PressedArrow: { dir: Schema.Literals(["left", "right", "up", "down"]) },
  PressedEnter: {},
  PressedEscape: {},
  PressedKeyList: {},
  PressedSide: {},
  PressedCaptions: {},
  PressedReviewKey: { action: ReviewAction },
  IgnoredKey: {},
  // 見返しの操作の行と <audio>
  ClickedToggle: {},
  ClickedPrev: {},
  ClickedNext: {},
  ClickedMute: {},
  ClickedCaptions: {},
  ClickedSide: {},
  ToggledRateMenu: {},
  ChoseRate: { rate: Schema.Number },
  ClosedRateMenu: {},
  PointedSeek: { value: Schema.NullOr(Schema.Number) },
  GotSeekSlider: { message: Slider.Message },
  GotVolumeSlider: { message: Slider.Message },
  TimedAudio: { time: Schema.Number },
  EndedAudio: {},
  FailedPlay: {},
  CompletedDom: {},
});
export type Message = typeof Message.Type;
