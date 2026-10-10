import fs from "node:fs";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";

if (process.argv[1]?.endsWith("/managedDepsRunner.ts")) {
  const { MANAGED_TEST_CONTROL: control, MANAGED_TEST_ID: id, MANAGED_TEST_POINT: point } = process.env;
  const link = fs.linkSync;
  const pause = () => {
    fs.writeFileSync(join(control, `${id}.reached`), String(process.pid));
    const waiting = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(join(control, `${id}.resume`))) Atomics.wait(waiting, 0, 0, 10);
  };
  fs.linkSync = function (from, to) {
    if (point === "execution-before") pause();
    const result = link.call(this, from, to);
    if (point === "execution-after") pause();
    return result;
  };
  syncBuiltinESMExports();
}
