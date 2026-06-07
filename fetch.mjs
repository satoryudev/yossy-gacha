#!/usr/bin/env node
// 津田沼近辺の複数ガチャ店のXポストを Nitter RSS で取得する。
// - data/feed.json   : 全店の最新ポスト（ヨッシー以外も含む）
// - data/matches.json: ウォッチ語ヒットの履歴（通知対象）
// 新規ヒットは Discord へ通知。GitHub Actions から定期実行する想定。

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// 監視対象（津田沼・習志野中心。Nitterで稼働確認済みのアカウントのみ）
const ACCOUNTS = [
  { handle: "Cplaviit",       shop: "C-pla 津田沼ビート店" },
  { handle: "Cpla62114446",   shop: "C-pla モリシア津田沼店" },
  { handle: "cpla_narashino", shop: "C-pla イオンタウン東習志野店" },
  { handle: "gachanomori",    shop: "ガチャガチャの森【公式】" },
];

// ウォッチ語（ヒットで通知＋ウォッチ一覧に表示）。"*" を含めると全件ヒット扱い（テスト用）。
const KEYWORDS = (process.env.KEYWORDS || "ヨッシー,よっしー,Yoshi")
  .split(",").map((s) => s.trim()).filter(Boolean);
const MATCH_ALL = KEYWORDS.includes("*");

// Nitter は不調になることがあるので複数を順に試す
const INSTANCES = (process.env.NITTER_INSTANCES ||
  "nitter.net,nitter.poast.org,nitter.privacydev.net,lightbrd.com")
  .split(",").map((s) => s.trim()).filter(Boolean);

const FEED_MAX = 80;
const SEEN_FILE = "data/seen.json";
const MATCH_FILE = "data/matches.json";
const FEED_FILE = "data/feed.json";

async function fetchRss(handle) {
  for (const inst of INSTANCES) {
    const url = `https://${inst}/${handle}/rss`;
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
          Accept: "application/rss+xml,text/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "ja,en;q=0.8",
          // undici 既定の br/gzip だと nitter が空ボディを返すことがあるため非圧縮を要求
          "Accept-Encoding": "identity",
        },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) { console.error(`  ${handle}@${inst}: HTTP ${res.status}`); continue; }
      const text = await res.text();
      if (text.includes("<item>")) { console.error(`  ${handle}: ${inst} OK`); return text; }
      console.error(`  ${handle}@${inst}: itemなし`);
    } catch (e) {
      console.error(`  ${handle}@${inst}: ${e.message}`);
    }
  }
  console.error(`  ${handle}: 取得失敗（スキップ）`);
  return null;
}

function decode(s) {
  return s
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

// nitter リンクを本家 x.com に正規化（リンク切れ防止＆重複判定をインスタンス非依存に）
function toXLink(url) {
  return url.replace(/^https?:\/\/[^/]+\//, "https://x.com/").replace(/#m$/, "");
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
    const hits = MATCH_ALL ? ["*"] : KEYWORDS.filter((k) => lower.includes(k.toLowerCase()));
    items.push({ account, shop, title, link, pubDate: pick("pubDate"), guid: link, hits });
  }
  return items;
}

async function notifyDiscord(matches) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url || !matches.length) return;
  const content = matches
    .map((m) => `🎯 **入荷の可能性**（${m.shop}）\n${m.title.replace(/\s+/g, " ").slice(0, 140)}\n${m.link}`)
    .join("\n\n")
    .slice(0, 1900);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    console.error(`Discord通知: HTTP ${res.status}`);
  } catch (e) {
    console.error(`Discord通知失敗: ${e.message}`);
  }
}

function load(file, fallback) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; }
}
function save(file, obj) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
}

// --- 全店取得 ---
const all = [];
for (const { handle, shop } of ACCOUNTS) {
  const xml = await fetchRss(handle);
  if (xml) all.push(...parse(xml, handle, shop));
}
all.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
console.error(
  `合計 ${all.length}件 / ${ACCOUNTS.length}店 / ウォッチ語: ${MATCH_ALL ? "全件(*)" : KEYWORDS.join(", ")}`
);

// --- フィード（全店の最新。ヨッシー以外も含む）---
save(FEED_FILE, all.slice(0, FEED_MAX));

// --- ウォッチ・ヒット（履歴＆通知）---
const seen = new Set(load(SEEN_FILE, []));
const matchesStore = load(MATCH_FILE, []);
const firstRun = seen.size === 0;

const newHits = all.filter((it) => it.hits.length && !seen.has(it.guid));
for (const it of all) seen.add(it.guid);

if (newHits.length) {
  console.log(`🎯 ウォッチ新着 ${newHits.length}件${firstRun ? "（初回・通知スキップ）" : ""}`);
  for (const m of newHits) console.log(`- [${m.shop}] ${m.title.replace(/\s+/g, " ").slice(0, 70)}`);
  matchesStore.unshift(...newHits);
  if (!firstRun) await notifyDiscord(newHits);
} else {
  console.log("ウォッチ新着なし");
}

save(SEEN_FILE, [...seen]);
save(MATCH_FILE, matchesStore.slice(0, 200));
save("data/status.json", {
  lastChecked: new Date().toISOString(),
  shops: ACCOUNTS.map((a) => a.shop),
  keywords: MATCH_ALL ? ["*（全件・テスト）"] : KEYWORDS,
  fetched: all.length,
  feedCount: Math.min(all.length, FEED_MAX),
  totalMatches: matchesStore.length,
});
