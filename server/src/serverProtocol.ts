import { Effect, Schema } from "effect";
import { IntakeStatusReport } from "./core/intake.ts";
import { OcrSummary, RecordedEvent } from "./core/recordedProgress.ts";
import { OpenShareStatus, ShareMail, ShareStatus } from "./core/viewingShare.ts";
import { TransferredJudge } from "./judgeSelection.ts";
import { CheckReport, InstallBody, InstallEvent, Item, StartupWarnings, UpdateBody } from "./managedDepsProtocol.ts";
import { TransferredModel } from "./modelSelection.ts";

const TrueByDefault = Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true)));

const Vocabulary = Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed<ReadonlyArray<string>>([])));

export const SessionStartBody = Schema.Struct({
  app: Schema.NonEmptyString,
  title: Schema.optionalKey(Schema.String),
  audio: TrueByDefault,
  screen: TrueByDefault,
  vocab: Vocabulary,
  criteria: Schema.optionalKey(Schema.Array(Schema.String)),
  model: Schema.optionalKey(TransferredModel),
  judge: Schema.optionalKey(TransferredJudge),
});

export const SessionRecordedBody = Schema.Struct({
  file: Schema.NonEmptyString,
  noMap: Schema.optionalKey(Schema.Boolean),
  selfFile: Schema.optionalKey(Schema.NonEmptyString),
  title: Schema.optionalKey(Schema.String),
  vocab: Vocabulary,
  criteria: Schema.optionalKey(Schema.Array(Schema.String)),
  realtime: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  model: Schema.optionalKey(TransferredModel),
  judge: Schema.optionalKey(TransferredJudge),
});

export const ShareOpenBody = Schema.Union([
  Schema.Struct({ anyone: Schema.optionalKey(Schema.Literal(true)) }),
  Schema.Struct({ mails: Schema.Array(ShareMail).check(Schema.isMinLength(1)) }),
]);

export const SelfPauseBody = Schema.Struct({ paused: Schema.Boolean });

export const SpeakerNameBody = Schema.Struct({ label: Schema.String, name: Schema.String });

const StartedSession = Schema.Struct({ dir: Schema.String, ...StartupWarnings.fields });
const StoppedSession = Schema.Struct({ paths: Schema.Array(Schema.String), ocrSummary: OcrSummary, kind: Schema.Literals(["live", "recorded"]) });
const ServerIdentity = Schema.Struct({ pid: Schema.Int.check(Schema.isGreaterThan(0)) });

export type ServerRoute = {
  readonly method: "GET" | "POST";
  readonly path: `/${string}`;
  readonly body?: Schema.Top;
  readonly response: Schema.Top;
};

export const ServerRoutes = {
  apps: { method: "GET", path: "/apps", response: Schema.Unknown },
  sessionStart: { method: "POST", path: "/session/start", body: SessionStartBody, response: StartedSession },
  sessionRecorded: { method: "POST", path: "/session/recorded", body: SessionRecordedBody, response: RecordedEvent },
  sessionStop: { method: "POST", path: "/session/stop", response: StoppedSession },
  sessionStatus: { method: "GET", path: "/session/status", response: IntakeStatusReport },
  sessionResume: { method: "POST", path: "/session/resume", response: StartupWarnings },
  sessionSelfPause: { method: "POST", path: "/session/self-pause", body: SelfPauseBody, response: Schema.Void },
  sessionSpeakerName: { method: "POST", path: "/session/speaker-name", body: SpeakerNameBody, response: Schema.Void },
  shareOpen: { method: "POST", path: "/share/open", body: ShareOpenBody, response: OpenShareStatus },
  shareClose: { method: "POST", path: "/share/close", response: ShareStatus },
  shareStatus: { method: "GET", path: "/share/status", response: ShareStatus },
  server: { method: "GET", path: "/server", response: ServerIdentity },
  check: { method: "GET", path: "/check", response: CheckReport },
  depsCheck: { method: "GET", path: "/deps/check", response: Schema.Array(Item) },
  depsInstall: { method: "POST", path: "/deps/install", body: InstallBody, response: InstallEvent },
  update: { method: "POST", path: "/update", body: UpdateBody, response: InstallEvent },
  feed: { method: "GET", path: "/ws", response: Schema.Void },
} as const satisfies Record<string, ServerRoute>;
