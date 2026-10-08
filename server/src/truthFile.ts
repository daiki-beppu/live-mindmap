// 正解ファイル（--truth、--screen-truth）の読み込み。cli の eval と bench の sttReplay が共有する。
// 失敗は InvalidTruthFile にし、表示（日本語の 1 行）は各入口が持つ。
import { Effect, FileSystem, Predicate, Schema, SchemaIssue, type PlatformError } from "effect";
import { ScreenTruth, Truth } from "./core/index.ts";

class InvalidTruthFile extends Schema.TaggedError<InvalidTruthFile>()("InvalidTruthFile", {
  path: Schema.String,
  reason: Schema.String,
}) {}
export { InvalidTruthFile };

// 入口の 1 行は 1 行に保つ（stderr を読む側は 1 行だけを期待する）
export const oneLine = (text: string): string => text.replaceAll(/\r?\n/g, " ");
export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
export const describe = (e: unknown): string => oneLine(errorMessage(e));

export const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

export const readTextFile = (path: string) => Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(path));

// 読めなかった理由を 1 行にする。PlatformError の message は "NotFound: FileSystem.readFile (path)" の形で OS のコードを含まないので、
// 元の Error（cause）の message（"ENOENT: no such file or directory, open '…'"）を優先する
export const fileReason = (error: PlatformError.PlatformError): string =>
  oneLine(Predicate.isError(error.cause) ? error.cause.message : error.message);

// 正解ファイルの decode の失敗を 1 行の理由にする。文面は core/evaluate.ts の Truth が正本で、ここは場所だけを足す
// （path は [種別] か [種別, 件目, ...]。どこを直すかは種別と件目で足りるので、field 名は添えない）。
// union や配列の要素は 1 つの誤りから複数の issue になるため、同じ行になったものは 1 つにまとめる
const truthReason = (error: Schema.SchemaError): string =>
  oneLine(
    [
      ...new Set(
        formatIssues(error.issue).issues.map(({ message, path }) => {
          const [kind, index] = (path ?? []).map((segment) => (Predicate.isObject(segment) ? segment.key : segment));
          if (!Predicate.isString(kind)) return message;
          return Predicate.isNumber(index) ? `「${kind}」の ${index + 1} 件目: ${message}` : `「${kind}」${message}`;
        }),
      ),
    ].join(" / "),
  );

// 正解ファイルの検証は core/evaluate.ts の Schema が 1 つだけ持つ（失敗のタグと理由の作り方はここで共有する）
const readFileWith = <S extends Schema.Decoder<unknown>>(schema: S) => (path: string) =>
  readTextFile(path).pipe(
    Effect.mapError((e) => new InvalidTruthFile({ path, reason: fileReason(e) })),
    Effect.flatMap((text) =>
      Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text).pipe(
        Effect.mapError((e) => new InvalidTruthFile({ path, reason: truthReason(e) })),
      ),
    ),
  );

export const readTruthFile = readFileWith(Truth);
export const readScreenTruthFile = readFileWith(ScreenTruth);
