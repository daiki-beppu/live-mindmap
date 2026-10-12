import { readFileSync } from "node:fs";
const img = (p) => "data:image/jpeg;base64," + readFileSync(p).toString("base64");
const [a, b] = process.argv.slice(2);
const body = { model: "clef-flash", state: "1 枚目は直前に AI に渡した会議アプリの画面、2 枚目は新しい画面。", images: [img(a), img(b)],
  questions: { changed: { type: "noul", instructions: "2 枚目は 1 枚目と比べて、共有されている資料の中身（文字・表・図・スライド）が変わったか" } } };
const t = performance.now();
const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/cloudflare/clef-flash`, { method: "POST", headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
console.log(r.status, Math.round(performance.now() - t), JSON.stringify(await r.json()).slice(0, 800));
