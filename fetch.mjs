#!/usr/bin/env node
// @Cplaviit（#C-pla 津田沼ビート店）のポストを Nitter RSS で取得し、
// キーワードに当たる新着だけを data/ に追記する。GitHub Actions から定期実行する想定。

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const ACCOUNT = process.env.ACCOUNT || "Cplaviit";
const KEYWORDS = (process.env.KEYWORDS || "ヨッシー,よっしー,Yoshi")
  .split(",").map((s) => s.trim()).filter(Boolean);
// Nitter インスタンスは落ちることがあるので複数を順に試す
const INSTANCES = (process.env.NITTER_INSTANCES ||
  "nitter.net,nitter.poast.org,nitter.privacydev.net,lightbrd.com")
  .split(",").map((s) => s.trim()).filter(Boolean);

const SEEN_FILE = "data/seen.json";
const MATCH_FILE = "data/matches.json";

async function fetchRss() {
  for (const inst of INSTANCES) {
    const url = `https://${inst}/${ACCOUNT}/rss`;
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
      if (!res.ok) { console.error(`  ${inst}: HTTP ${res.status}`); continue; }
      const text = await res.text();
      if (text.includes("<item>")) {
        console.error(`  取得元: ${inst}`);
        return text;
      }
      console.error(`  ${inst}: itemなし`);
    } catch (e) {
      console.error(`  ${inst}: ${e.message}`);
    }
  }
  throw new Error("全Nitterインスタンスからの取得に失敗しました");
}

function decode(s) {
  return s
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

// nitter のリンクを本家 x.com に正規化（リンク切れ防止＆重複判定をインスタンス非依存にする）
function toXLink(url) {
  return url
    .replace(/^https?:\/\/[^/]+\//, "https://x.com/")
    .replace(/#m$/, "");
}

function parse(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    const pick = (tag) => {
      const r = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block);
      return r ? decode(r[1]).trim() : "";
    };
    const link = toXLink(pick("link"));
    items.push({
      title: pick("title"),
      link,
      pubDate: pick("pubDate"),
      guid: link,
    });
  }
  return items;
}

function load(file, fallback) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; }
}
function save(file, obj) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
}

const xml = await fetchRss();
const items = parse(xml);
console.error(`取得: ${items.length}件 / キーワード: ${KEYWORDS.join(", ")}`);

const seen = new Set(load(SEEN_FILE, []));
const matchesStore = load(MATCH_FILE, []);
const firstRun = seen.size === 0;

const newMatches = [];
for (const it of items) {
  const lower = it.title.toLowerCase();
  const hit = KEYWORDS.some((k) => lower.includes(k.toLowerCase()));
  if (hit && !seen.has(it.guid)) newMatches.push(it);
}
// 評価済みとして全件を記録（次回以降の重複アラート防止）
for (const it of items) seen.add(it.guid);

if (newMatches.length) {
  console.log(`🎯 新着ヒット ${newMatches.length}件${firstRun ? "（初回実行）" : ""}`);
  for (const m of newMatches) {
    console.log(`- [${m.pubDate}] ${m.title.replace(/\s+/g, " ").slice(0, 80)}`);
    console.log(`  ${m.link}`);
  }
  matchesStore.unshift(...newMatches);
} else {
  console.log("新着ヒットなし");
}

save(SEEN_FILE, [...seen]);
save(MATCH_FILE, matchesStore);
