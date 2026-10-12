// 表のセルに入れる文字列。区切りの `|` と、その直前の `\` をエスケープし、改行は空白 1 つにして 1 行に保つ
export const escapeCell = (cell: string) => cell.replace(/[\\|]/g, "\\$&").replace(/\r\n|\r|\n/g, " ");
