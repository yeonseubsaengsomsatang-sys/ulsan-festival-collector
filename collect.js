// Ulsan festival / booth-recruitment collector.
// Pure HTTP + regex — no LLM calls, runs entirely inside GitHub Actions.
//
// How it works:
// 1. For each configured government board URL, fetch the raw HTML.
// 2. Extract every <a href="...">text</a> whose text matches KEYWORD_RE.
// 3. Diff against data/seen.json (URLs already surfaced in a past run).
// 4. Anything genuinely new gets appended to data/collected.json (the
//    public feed the homepage artifact fetches and merges into its
//    "자동수집 대기" queue for human review/approval).
//
// Adapter confidence:
//   VERIFIED  - URL structure confirmed byte-for-byte during manual testing
//   INFERRED  - built from the site's own view.do/list.do naming convention;
//               not yet confirmed to return rows. Check the Action log's
//               per-board item count on the first few runs.
//   SKIPPED   - board requires session/POST state (eminwon) or an exact
//               endpoint we don't have yet; left out rather than guessed.

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const SEEN_PATH = path.join(DATA_DIR, "seen.json");
const OUT_PATH = path.join(DATA_DIR, "collected.json");

const KEYWORD_RE =
  /(축제|체험\s*부스|판매\s*부스|먹거리\s*부스|식음료\s*부스|프리마켓|플리마켓|나눔장터|셀러\s*모집|셀러모집|부스\s*모집|부스운영|부스\s*참가|판매자\s*모집|참여상인\s*모집|운영자\s*모집|참가업체\s*모집|참가자\s*모집)/;

// Titles that structurally match the keyword regex but are almost never a
// real recruitment notice (menu labels, past-tense wrap-up articles, etc.)
const NOISE_RE = /(성황리|마무리|종료|안내드립니다$|바랍니다$|메뉴|사이트맵)/;

const KEYWORDS_FOR_SEARCH = ["축제", "부스", "셀러", "프리마켓", "체험부스", "판매부스", "모집"];

const BOARDS = [
  // ---- 북구청 (VERIFIED 2026-09-24: raw HTML confirmed server-rendered) ----
  { org: "울산광역시 북구청", sourceOrg: "북구청 알림사항", url: "https://www.bukgu.ulsan.kr/lay1/bbs/S1T62C83/A/1/list.do" },
  { org: "울산광역시 북구청", sourceOrg: "북구청 북구공보", url: "https://www.bukgu.ulsan.kr/lay1/bbs/S1T1903C104/A/1/list.do" },
  { org: "울산광역시 북구청", sourceOrg: "북구청 타기관소식", url: "https://www.bukgu.ulsan.kr/lay1/bbs/S1T62C101/A/1/list.do" },

  // ---- 중구청 (INFERRED: view.ulsan -> list.ulsan by the site's own naming convention) ----
  { org: "울산광역시 중구청", sourceOrg: "중구청 새소식", url: "https://www.junggu.ulsan.kr/board/list.ulsan?boardId=BBS_0000057&menuCd=DOM_000000102003001000&paging=ok&startPage=1" },

  // ---- 동구청 (VERIFIED working keyword search per site testing 2026-09-24) ----
  ...["BBSMSTR_000000000323", "BBSMSTR_000000000322"].flatMap((bbsId) =>
    KEYWORDS_FOR_SEARCH.map((kw) => ({
      org: "울산광역시 동구청",
      sourceOrg: bbsId === "BBSMSTR_000000000323" ? "동구청 알림사항" : "동구청 보도자료",
      url: `https://www.donggu.ulsan.kr/cop/bbs/selectBoardList.do?bbsId=${bbsId}&searchWrd=${encodeURIComponent(kw)}`,
    }))
  ),

  // ---- 남구청 (INFERRED: selectBoardArticle.do -> selectBoardList.do convention) ----
  { org: "울산광역시 남구청", sourceOrg: "남구청 새소식", url: "https://www.ulsannamgu.go.kr/cop/bbs/selectBoardList.do?bbsId=namguNews" },

  // ---- 울주군청 (VERIFIED working search endpoint per site testing 2026-09-24) ----
  ...KEYWORDS_FOR_SEARCH.map((kw) => ({
    org: "울산광역시 울주군청",
    sourceOrg: "울주군청 통합검색",
    url: `https://www.ulju.ulsan.kr/search/front/Search.jsp?searchKey=total&qt=${encodeURIComponent(kw)}`,
  })),

  // ---- 울산광역시청 (INFERRED: bbs/view.do -> bbs/list.do convention) ----
  { org: "울산광역시청", sourceOrg: "울산시청 울산소식", url: "https://www.ulsan.go.kr/u/rep/bbs/list.do?bbsId=BBS_0000000000000003&mId=001004001001000000" },

  // ---- SKIPPED: 남구청 고시공고(eminwon, POST/세션 필요) — 확실한 GET 엔드포인트 확보 전까지 제외 ----
];

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; UlsanFestivalCollector/1.0)" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

// Generic anchor extractor: works across differing board markups without
// needing a bespoke <tr> regex per site.
const ANCHOR_RE = /<a\s+[^>]*href="([^"#][^"]*)"[^>]*>([\s\S]{1,200}?)<\/a>/g;

function extractCandidates(html, pageUrl) {
  const out = [];
  let m;
  ANCHOR_RE.lastIndex = 0;
  while ((m = ANCHOR_RE.exec(html))) {
    const rawText = m[2].replace(/<[^>]*>/g, "");
    const text = decodeEntities(rawText);
    if (text.length < 4 || text.length > 80) continue;
    if (!KEYWORD_RE.test(text) || NOISE_RE.test(text)) continue;
    let absUrl;
    try {
      absUrl = new URL(decodeEntities(m[1]), pageUrl).href;
    } catch {
      continue;
    }
    out.push({ title: text, url: absUrl });
  }
  return out;
}

async function main() {
  const seen = fs.existsSync(SEEN_PATH) ? JSON.parse(fs.readFileSync(SEEN_PATH, "utf8")) : {};
  const existingCollected = fs.existsSync(OUT_PATH) ? JSON.parse(fs.readFileSync(OUT_PATH, "utf8")) : [];
  const stillPendingUrls = new Set(existingCollected.map((i) => i.url));

  const newItems = [];
  const perBoardCounts = [];

  for (const board of BOARDS) {
    try {
      const html = await fetchText(board.url);
      const candidates = extractCandidates(html, board.url);
      perBoardCounts.push(`${board.sourceOrg}: ${candidates.length}건 매칭 (원본 앵커 ${(html.match(/<a\s/g) || []).length}개 중)`);

      for (const c of candidates) {
        if (seen[c.url]) continue; // already surfaced in a past run
        seen[c.url] = { firstSeen: new Date().toISOString(), org: board.org };
        newItems.push({
          id: `gh-${Buffer.from(c.url).toString("base64url").slice(0, 24)}`,
          name: c.title,
          region: "울산",
          sourceOrg: board.sourceOrg,
          sourceUrl: c.url,
          collectedAt: new Date().toISOString(),
          status: "pending",
          organizerType: "official",
          memo: `자동수집(GitHub Actions, ${board.org}). 원문 확인 후 승인 필요 — 모집기간 등 세부정보는 원문에서 직접 확인.`,
        });
      }
    } catch (err) {
      perBoardCounts.push(`${board.sourceOrg}: FETCH FAILED — ${err.message}`);
    }
  }

  // Prune anything older than 45 days from the public feed — by then it's
  // either been reviewed (localStorage on the reviewer's own browser) or
  // stale enough not to matter. seen.json still remembers the URL forever,
  // so a pruned item never resurfaces as "new".
  const PRUNE_MS = 45 * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - PRUNE_MS;
  const merged = [...existingCollected, ...newItems].filter(
    (i) => new Date(i.collectedAt).getTime() >= cutoff
  );

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SEEN_PATH, JSON.stringify(seen, null, 2));
  fs.writeFileSync(OUT_PATH, JSON.stringify(merged, null, 2));

  console.log("=== 게시판별 결과 ===");
  perBoardCounts.forEach((l) => console.log(l));
  console.log(`\n신규 발견: ${newItems.length}건`);
  newItems.forEach((i) => console.log(` - [${i.sourceOrg}] ${i.name} -> ${i.sourceUrl}`));
  console.log(`\n누적 pending 총 ${merged.length}건 (data/collected.json)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
