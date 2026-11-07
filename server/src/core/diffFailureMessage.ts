export function diffFailureMessage(message: string): string {
  return message
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;"'<>]+/gi, "[認証情報を伏せました]")
    .replace(/((?:["']?)(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|authorization|x-api-key)(?:["']?)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&<>]+)/gi, "$1[秘密を伏せました]")
    .replace(/\b(?:sk|sess)-[a-z0-9_-]+/gi, "[鍵を伏せました]")
    .replace(/\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+/gi, "[トークンを伏せました]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[資格情報を伏せました]@")
    .replace(/[\r\n\t]+/g, " ");
}
