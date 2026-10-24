import { Effect, FileSystem, Predicate, Schema, SchemaIssue, type PlatformError } from "effect";
import { ScreenTruth, Truth } from "./core/index.ts";

class InvalidTruthFile extends Schema.TaggedError<InvalidTruthFile>()("InvalidTruthFile", {
  path: Schema.String,
  reason: Schema.String,
}) {}
export { InvalidTruthFile };

export const oneLine = (text: string): string => text.replaceAll(/\r?\n/g, " ");
export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
export const describe = (e: unknown): string => oneLine(errorMessage(e));

export const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

export const readTextFile = (path: string) => Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(path));

// 読めなかった理由を 1 行にする。PlatformError の message は "NotFound: FileSystem.readFile (path)" の形で OS のコードを含まないので、
// 元の Error（cause）の message（"ENOENT: no such file or directory, open '…'"）を優先する
export const fileReason = (error: PlatformError.PlatformError): string =>
  oneLine(Predicate.isError(error.cause) ? error.cause.message : error.message);

// union や配列の要素は 1 つの誤りから複数の issue になるため、同じ行になったものは 1 つにまとめる
const truthReason = (error: Schema.SchemaError): string =>
  oneLine(
    [
      ...new Set(
        formatIssues(error.issue).issues.map(({ message, path }) => {
          const [kind, index] = (path ?? []).map((segment) => (Predicate.isObject(segment) ? segment.key : segment));
          return Predicate.isString(kind) && Predicate.isNumber(index) ? `「${kind}」の ${index + 1} 件目: ${message}` : message;
        }),
      ),
    ].join(" / "),
  );

const readFileWith = <S extends Schema.Decoder<unknown>>(schema: S) => (path: string) =>
  readTextFile(path).pipe(
    Effect.mapError((e) => new InvalidTruthFile({ path, reason: fileReason(e) })),
    Effect.flatMap((text) =>
      Schema.decodeEffect(Schema.fromJsonString(schema))(text).pipe(
        Effect.mapError((e) => new InvalidTruthFile({ path, reason: truthReason(e) })),
      ),
    ),
  );

export const readTruthFile = readFileWith(Truth);
export const readScreenTruthFile = readFileWith(ScreenTruth);
