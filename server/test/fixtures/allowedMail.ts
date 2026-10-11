export const allowedMails = (args: ReadonlyArray<string>): string[] =>
  args.flatMap((arg, i) => {
    if (arg !== "--allowed-mail") return [];
    const value = args[i + 1];
    if (value === undefined) throw new Error("--allowed-mail に値がない");
    return value.split(",");
  }).sort();
