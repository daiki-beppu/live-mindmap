// 合言葉の生成と、暗号化・復号（Issue #1251）。Node に依存しない（WebCrypto・atob・btoa は globalThis のものを使う）。
// 鍵の導出は PBKDF2-SHA256（回数が多く、1 回に時間がかかる）、暗号は AES-256-GCM（認証つき。合言葉が違えば復号が失敗する）。
//
// 置く側（Node）と、置いた HTML の中のスクリプトが「同じ実装」を使うために、復号の関数をこのモジュールに 1 つだけ書き、
// ページのスクリプトは同じ関数の toString() から作る（unlockPageScript）。ページ側に写した別の実装を持たない。
// そのため、下の「ページに入る関数」は次の規則を守る:
//   - すべて function 宣言にする（アロー関数を const に入れない）
//   - 本文から参照するのは、引数・globalThis の API・unlockPageScript が先頭に置く定数（下の PAGE_CONSTANTS）だけ
//   - import した識別子を参照しない（テスト・ビルドの変換が識別子を書き換えるため、文字列にすると壊れる）

// 32 文字。紛らわしい 0 o 1 l を除く
const PASSPHRASE_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";
const PASSPHRASE_GROUPS = 4;
const PASSPHRASE_GROUP_LENGTH = 5;
const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const SEALED_ELEMENT_ID = "live-mindmap-sealed";

export type Sealed = { readonly salt: string; readonly iv: string; readonly data: string };

// 32 は 256 を割り切るので、バイトを 32 で割った余りに偏りが出ない。Discord の markdown が解釈する * _ ~ | ` と空白を含まない
export function generatePassphrase(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(PASSPHRASE_GROUPS * PASSPHRASE_GROUP_LENGTH));
  const chars = Array.from(bytes, (byte) => PASSPHRASE_ALPHABET[byte % PASSPHRASE_ALPHABET.length]!);
  const groups: string[] = [];
  for (let at = 0; at < chars.length; at += PASSPHRASE_GROUP_LENGTH) groups.push(chars.slice(at, at + PASSPHRASE_GROUP_LENGTH).join(""));
  return groups.join("-");
}

/* ---- ここから下の function 宣言は、ページのスクリプトにそのまま入る ---- */

function bytesToBase64(bytes: Uint8Array): string {
  // 25 MiB 近い入力もあるので、String.fromCharCode(...bytes) を一度に呼ばず、分けて変換する
  let binary = "";
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(at, at + 0x8000)));
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at++) bytes[at] = binary.charCodeAt(at);
  return bytes;
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function sealWithPassphrase(plaintext: string, passphrase: string): Promise<Sealed> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(passphrase, salt);
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, new TextEncoder().encode(plaintext));
  return { salt: bytesToBase64(salt), iv: bytesToBase64(iv), data: bytesToBase64(new Uint8Array(encrypted)) };
}

// 合言葉が違う・暗号文が壊れているときは reject する（GCM の認証タグの検証で失敗する）
export async function openSealed(sealed: Sealed, passphrase: string): Promise<string> {
  const key = await deriveKey(passphrase, base64ToBytes(sealed.salt));
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBytes(sealed.iv) as BufferSource }, key, base64ToBytes(sealed.data) as BufferSource);
  return new TextDecoder().decode(decrypted);
}

// ページの入口。入力を読み、復号できたらマップのページに置き換える。違えば「合言葉が違います」を出す
function bootUnlockPage(): void {
  const form = document.querySelector("form") as HTMLFormElement;
  const input = form.querySelector("input") as HTMLInputElement;
  const message = document.querySelector("[role=alert]") as HTMLElement;
  form.addEventListener("submit", (event: Event) => {
    event.preventDefault();
    const sealed = JSON.parse((document.getElementById(SEALED_ELEMENT_ID) as HTMLElement).textContent as string) as Sealed;
    message.textContent = "確かめています…";
    // Discord からコピーすると前後に空白が付くことがある
    openSealed(sealed, input.value.trim()).then(
      (html: string) => {
        document.open();
        document.write(html);
        document.close();
      },
      () => {
        message.textContent = "合言葉が違います";
      },
    );
  });
}

/* ---- ページに入る関数ここまで ---- */

// 先頭に置く定数。関数の本文はこれらの名前を参照する
function pageConstants(): string {
  return [
    `const PBKDF2_ITERATIONS = ${JSON.stringify(PBKDF2_ITERATIONS)};`,
    `const SEALED_ELEMENT_ID = ${JSON.stringify(SEALED_ELEMENT_ID)};`,
  ].join("\n");
}

// 外側のページに置くスクリプト（<script> の中身）。SEALED_ELEMENT_ID は暗号文の script 要素の id
export function unlockPageScript(): string {
  const functions = [bytesToBase64, base64ToBytes, deriveKey, openSealed, bootUnlockPage].map((fn) => fn.toString());
  return `${pageConstants()}\n${functions.join("\n")}\nbootUnlockPage();\n`;
}

export const SEALED_SCRIPT_ID = SEALED_ELEMENT_ID;
