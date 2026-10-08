import { Schema } from "effect";
import { DiffOutput } from "../src/core/index.ts";
console.log(JSON.stringify(Schema.toJsonSchemaDocument(DiffOutput, { onExcessProperty: "error" })));
