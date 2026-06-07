#!/usr/bin/env node
// 津田沼近辺の複数ガチャ店のXポストを Nitter RSS で取得する。
// - data/feed.json    : 全店の最新ポスト（画像URL・AI判定つき）
// - data/matches.json : ヨッシー・ヒットの履歴（通知対象）
// - data/analyzed.json: 画像のAI判定キャッシュ（同じ画像を再解析しない）
// ヨッシー判定は「本文キーワード」＋「画像をCLIPゼロショット分類」の二段。
// CLIP(@xenova/transformers)はローカル実行＝完全無料・APIキー不要。

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const ACCOUNTS = [
  { handle: "Cplaviit",       shop: "C-pla 津田沼ビート店" },
  { handle: "Cpla62114446",   shop: "C-pla モリシア津田沼店" },
  { handle: "cpla_narashino", shop: "C-pla イオンタウン東習志野店" },
  { handle: "gachanomori",    shop: "ガチャガチャの森【公式】" },
];

const KEYWORDS = (process.env.KEYWORDS || "ヨッシー,よっしー,Yoshi")
  .split(",").map((s) => s.trim()).filter(Boolean);

const INSTANCES = (process.env.NITTER_INSTANCES ||
  "nitter.net,nitter.poast.org,nitter.privacydev.net,lightbrd.com")
  .split(",").map((s) => s.trim()).filter(Boolean);

// 画像をAI判定する候補：本文がこの語を含み、画像があり、未解析のもの
const PRODUCT_HINT = /入荷|再入荷|入荷予定|予定表|完売|商品|登場|発売|マリオ|ヨッシー/;
const VISION_MAX = Number(process.env.VISION_MAX || 8); // 1回の実行で解析する最大画像数
const YOSHI_THRESHOLD = Number(process.env.YOSHI_THRESHOLD || 0.4);
const CLIP_MODEL = "Xenova/clip-vit-base-patch32";
const LABEL_YOSHI = "Yoshi, the green dinosaur character from Nintendo Super Mario";
const LABEL_OTHER = "some other video game or anime character goods, not Yoshi";

const FEED_MAX = 80;
const NOTIFIED_FILE = "data/notified.json";
const MATCH_FILE = "data/matches.json";
const FEED_FILE = "data/feed.json";
const ANALYZED_FILE = "data/analyzed.json";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const RSS_HEADERS = {
  "User-Agent": UA,
  Accept: "application/rss+xml,text/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "ja,en;q=0.8",
  "Accept-Encoding": "identity", // undici 既定の br/gzip だと nitter が空ボディを返すため
};

async function fetchRss(handle) {
  for (const inst of INSTANCES) {
    try {
      const res = await fetch(`https://${inst}/${handle}/rss`, { headers: RSS_HEADERS, signal: AbortSignal.timeout(20000) });
      if (!res.ok) { console.error(`  ${handle}@${inst}: HTTP ${res.status}`); continue; }
      const text = await res.text();
      if (text.includes("<item>")) { console.error(`  ${handle}: ${inst} OK`); return text; }
      console.error(`  ${handle}@${inst}: itemなし`);
    } catch (e) { console.error(`  ${handle}@${inst}: ${e.message}`); }
  }
  console.error(`  ${handle}: 取得失敗（スキップ）`);
  return null;
}

function decode(s) {
  return s.replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}
function toXLink(url) {
  return url.replace(/^https?:\/\/[^/]+\//, "https://x.com/").replace(/#m$/, "");
}
// nitter のプロキシ画像URL → 本家 pbs.twimg.com に復元
function toImageUrls(descHtml) {
  const urls = [];
  for (const m of descHtml.matchAll(/<img[^>]+src="([^"]+)"/g)) {
    const idx = m[1].indexOf("/pic/");
    if (idx === -1) continue;
    let path = decodeURIComponent(m[1].slice(idx + 5)).replace(/^orig\//, "");
    if (!path.startsWith("media/")) continue;
    urls.push("https://pbs.twimg.com/" + path);
  }
  return [...new Set(urls)];
}

function parse(xml, account, shop) {
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    const pick = (tag) => {
      const r = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block);
      return r ? decode(r[1]).trim() : "";
    };
    const link = toXLink(pick("link"));
    const title = pick("title");
    const lower = title.toLowerCase();
    items.push({
      account, shop, title, link,
      pubDate: pick("pubDate"),
      guid: link,
      images: toImageUrls(pick("description")),
      textHits: KEYWORDS.filter((k) => lower.includes(k.toLowerCase())),
      vision: null,
    });
  }
  return items;
}

// --- CLIP(ゼロショット画像分類) ---
let _clf = null;
async function getClassifier() {
  if (_clf) return _clf;
  const { pipeline, env } = await import("@xenova/transformers");
  env.cacheDir = process.env.TRANSFORMERS_CACHE || "./.tfcache";
  _clf = await pipeline("zero-shot-image-classification", CLIP_MODEL);
  return _clf;
}
async function analyzeImage(imageUrl) {
  let tmp;
  try {
    const ir = await fetch(imageUrl, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
    if (!ir.ok) { console.error(`    画像DL HTTP ${ir.status}`); return null; }
    tmp = join(tmpdir(), "yg_" + Math.random().toString(36).slice(2) + ".img");
    writeFileSync(tmp, Buffer.from(await ir.arrayBuffer()));
    const clf = await getClassifier();
    const out = await clf(tmp, [LABEL_YOSHI, LABEL_OTHER]);
    const score = out.find((o) => o.label === LABEL_YOSHI)?.score ?? 0;
    return { yoshi: score >= YOSHI_THRESHOLD, score: Math.round(score * 1000) / 1000 };
  } catch (e) {
    console.error(`    画像判定失敗: ${e.message}`);
    return null;
  } finally {
    if (tmp) try { unlinkSync(tmp); } catch {}
  }
}

function load(file, fallback) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; }
}
function save(file, obj) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
}

async function notifyDiscord(hits) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url || !hits.length) return;
  const content = hits.map((m) => {
    const why = m.vision?.yoshi ? `🖼 画像判定 ${Math.round(m.vision.score * 100)}%` : "📝 本文ヒット";
    return `🎯 **ヨッシーの可能性**（${m.shop} / ${why}）\n${m.title.replace(/\s+/g, " ").slice(0, 120)}\n${m.link}`;
  }).join("\n\n").slice(0, 1900);
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content }) });
    console.error(`Discord通知: HTTP ${res.status}`);
  } catch (e) { console.error(`Discord通知失敗: ${e.message}`); }
}

const isHit = (it) => it.textHits.length > 0 || (it.vision && it.vision.yoshi);

// --- 全店取得 ---
const all = [];
for (const { handle, shop } of ACCOUNTS) {
  const xml = await fetchRss(handle);
  if (xml) all.push(...parse(xml, handle, shop));
}
all.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
console.error(`合計 ${all.length}件 / ${ACCOUNTS.length}店`);

// --- 画像のCLIP判定（候補のみ・キャッシュ利用）---
const analyzed = load(ANALYZED_FILE, {});
const candidates = all.filter(
  (it) => it.images.length && PRODUCT_HINT.test(it.title) && !it.textHits.length && !(it.guid in analyzed)
);
console.error(`画像判定候補: ${candidates.length}件（今回最大${VISION_MAX}件解析）`);
for (const it of candidates.slice(0, VISION_MAX)) {
  const res = await analyzeImage(it.images[0]);
  if (res) {
    analyzed[it.guid] = res;
    console.error(`    ${it.shop}: yoshi=${res.yoshi} (${Math.round(res.score * 100)}%)`);
  }
}
for (const it of all) if (analyzed[it.guid]) it.vision = analyzed[it.guid];

// --- フィード（全店の最新）---
save(FEED_FILE, all.slice(0, FEED_MAX));

// --- ヒット（履歴＆通知）---
const firstRun = !existsSync(NOTIFIED_FILE);
const notified = new Set(load(NOTIFIED_FILE, []));
const matchesStore = load(MATCH_FILE, []);

const hitsNow = all.filter(isHit);
const newHits = hitsNow.filter((it) => !notified.has(it.guid));
for (const it of hitsNow) notified.add(it.guid);

if (newHits.length) {
  console.log(`🎯 ヨッシー新着 ${newHits.length}件${firstRun ? "（初回・通知スキップ）" : ""}`);
  for (const m of newHits) console.log(`- [${m.shop}] ${m.title.replace(/\s+/g, " ").slice(0, 60)}`);
  matchesStore.unshift(...newHits);
  if (!firstRun) await notifyDiscord(newHits);
} else {
  console.log("ヨッシー新着なし");
}

save(NOTIFIED_FILE, [...notified].slice(-500));
save(MATCH_FILE, matchesStore.slice(0, 200));
save(ANALYZED_FILE, Object.fromEntries(Object.entries(analyzed).slice(-300)));
save("data/status.json", {
  lastChecked: new Date().toISOString(),
  shops: ACCOUNTS.map((a) => a.shop),
  keywords: KEYWORDS,
  visionMethod: "CLIP(無料・ローカル)",
  fetched: all.length,
  feedCount: Math.min(all.length, FEED_MAX),
  totalMatches: matchesStore.length,
});
