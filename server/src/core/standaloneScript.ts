type Standalone = (...args: never[]) => unknown;

export function standaloneSource(...fns: readonly Standalone[]): string {
  return fns.map((fn) => fn.toString()).join("\n");
}
