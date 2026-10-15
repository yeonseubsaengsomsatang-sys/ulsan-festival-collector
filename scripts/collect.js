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

  // ---- 동구청 (FIXED 2026-10-05: ?searchWrd= does nothing — the site's real search
  // submits via POST with a CSRF token, so GET keyword search was silently returning
  // the same unfiltered page 1 every time. Switched to plain multi-page listing
  // (like 북구청) so the existing local keyword regex has real content to scan.) ----
  ...["BBSMSTR_000000000323", "BBSMSTR_000000000322"].flatMap((bbsId) =>
    [1, 2, 3].map((page) => ({
      org: "울산광역시 동구청",
      sourceOrg: bbsId === "BBSMSTR_000000000323" ? "동구청 알림사항" : "동구청 보도자료",
      url: `https://www.donggu.ulsan.kr/cop/bbs/selectBoardList.do?bbsId=${bbsId}&pageIndex=${page}`,
    }))
  ),

  // ---- 남구청 (FIXED 2026-10-05: bbsId=namguNews is a traffic/tax/civil-affairs board —
  // checked 18 pages back, zero festival-related posts. bbsId=press (보도자료) actually
  // carries them, e.g. "고래문화재단, 제30회 울산고래축제 자원봉사 활동가 모집".) ----
  ...[1, 2, 3].map((page) => ({
    org: "울산광역시 남구청",
    sourceOrg: "남구청 보도자료",
    url: `https://www.ulsannamgu.go.kr/cop/bbs/selectBoardList.do?bbsId=press&pageIndex=${page}`,
  })),

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

// ---- 경주시·김해시 확대 (2026-10-15 수동 검증) ----
// 조사 방법: 각 사이트를 직접 fetch해서 실제 서버 렌더링 HTML에 글 목록이 나오는지
// 확인하고, 나온 경우에만 등록함(추측 URL 없음). 조사 결과:
//   - 경주시청 메인 사이트(gyeongju.go.kr)는 "page.do?mnu_uid=N" 게시판이 서버
//     렌더링되어 VERIFIED. 공지사항(416)·고시공고(423)는 실제 글이 있었음.
//   - 경주시 신라문화제 공식 사이트(gyeongju.go.kr/sillafestival)도 같은 CMS라
//     VERIFIED — 실제로 "2026 제53회 신라문화제 지역예술인 버스킹 참여자 모집
//     공고"(2026-09-03 게시)를 확인함.
//   - 김해시청 메인 사이트(gimhae.go.kr)는 공지사항/고시공고 URL(00024.web,
//     00029.web)에 접속은 되지만 실제 게시글 목록이 서버 HTML에 없고 자바스크립트로
//     그려지는 구조라 정규식 수집이 불가능 — SKIPPED(추측 등록 금지 원칙에 따라 제외).
//     김해문화관광재단(ghcf.or.kr)도 접속 자체가 실패(ERR fetch failed)해 제외.
//   - 김해시 진영단감축제 공식 사이트(gimhae.go.kr/dangam)는 서버 렌더링되어
//     VERIFIED — 실제로 "제42회 김해진영단감축제 체험부스팀. 공연팀 모집안내"
//     (2026-08-14 게시)를 확인함.
// 한계(정직하게 기록): 두 사이트 모두 모집기간·참가자격·신청방법이 본문 텍스트가
// 아니라 첨부파일(포스터 이미지 .jpg 또는 한글파일 .hwp)에만 들어있어, 정규식으로는
// 읽을 수 없음. 날짜를 추출하지 못한 항목은 recruitStatus를 "unknown"(확인필요)으로
// 남기고, memo에 "첨부파일 원문 확인 필요"라고 명시함 — 절대 임의로 모집중/마감을
// 추정하지 않음.
const GYEONGJU_GIMHAE_BOARDS = [
  {
    org: "경주시청",
    sourceOrg: "경주시청 공지사항",
    url: "https://www.gyeongju.go.kr/open_content/ko/page.do?mnu_uid=416",
    region: "경북",
    city: "경주",
  },
  {
    org: "경주시청",
    sourceOrg: "경주시청 고시공고",
    url: "https://www.gyeongju.go.kr/open_content/ko/page.do?mnu_uid=423",
    region: "경북",
    city: "경주",
  },
  {
    org: "신라문화제추진위원회",
    sourceOrg: "신라문화제 공식사이트 공지사항",
    url: "https://www.gyeongju.go.kr/sillafestival/page.do?mnu_uid=1895",
    region: "경북",
    city: "경주",
  },
  {
    org: "김해시청",
    sourceOrg: "진영단감축제 공식사이트 단감축제소식",
    // 주의: html/sub/05_01.jsp(게시판 목록 URL)는 실제로는 글 목록이 비어
    // 있었음(검증 결과 0건) — 루트 페이지(/dangam/)에 최근 글 위젯이 서버
    // 렌더링되어 있어 이쪽을 VERIFIED 수집처로 등록함.
    url: "https://www.gimhae.go.kr/dangam/",
    region: "경남",
    city: "김해",
  },
  // SKIPPED(검증 결과 수집 불가):
  //  - 김해시청 공지사항 https://www.gimhae.go.kr/00024.web (자바스크립트 렌더링, 글목록 없음)
  //  - 김해시청 고시공고 https://www.gimhae.go.kr/00029.web (위와 동일 사유)
  //  - 김해문화관광재단 http://www.ghcf.or.kr/ (접속 실패)
];

// 경주·김해 확대분 전용 키워드 — 기존 KEYWORD_RE는 그대로 두고(울산 보드 동작 불변),
// 이 사이트들에서 실제로 관찰된 표현("버스킹 참여자 모집", "체험부스팀. 공연팀 모집안내")을
// 추가로 포함한 더 넓은 정규식을 따로 둠.
const NEW_SITE_KEYWORD_RE = new RegExp(
  KEYWORD_RE.source + "|참여자\\s*모집|공연팀\\s*모집|모집\\s*안내|지역예술인.{0,10}모집"
);
// 목록 페이지의 순수 메뉴 링크(예: "축제안내", "축제갤러리")가 "축제"라는 글자 때문에
// KEYWORD_RE에 걸려 글이 아닌데도 후보로 들어오는 것을 막기 위해, 실제 게시글 상세
// URL에서만 쓰이는 파라미터(parm_bod_uid= 또는 amode=view)가 포함된 링크만 인정함.
const POST_LINK_RE = /parm_bod_uid=|amode=view/;

// 기존 ANCHOR_RE({1,200})는 그대로 두고(울산 보드 영향 없음), 새 사이트 전용으로만
// 더 넉넉한 캡처 범위를 씀 — 김해 진영단감축제 사이트의 "알림판" 배너 링크는 <img alt=...>
// 긴 설명문 때문에 태그 내부 길이가 200자를 넘어 기존 정규식으로는 아예 안 잡혔음(실측 296자).
const ANCHOR_RE_WIDE = /<a\s+[^>]*href="([^"#][^"]*)"[^>]*>([\s\S]{1,500}?)<\/a>/g;

function extractPostCandidates(html, pageUrl, keywordRe) {
  const out = [];
  let m;
  const re = new RegExp(ANCHOR_RE_WIDE.source, "g");
  while ((m = re.exec(html))) {
    const rawText = m[2].replace(/<[^>]*>/g, "");
    let text = decodeEntities(rawText).replace(/\s+/g, " ").trim();
    // 링크 텍스트가 비어있고 이미지(배너형 썸네일)만 있는 경우 — alt= 속성을
    // 제목으로 사용 (예: 김해 진영단감축제 메인 "알림판" 배너가 <img alt="...">만
    // 들어있고 보이는 텍스트가 없는 구조였음, 2026-10-15 실제 확인).
    if (text.length < 4) {
      const altMatch = m[2].match(/alt="([^"]{4,200})"/i);
      if (altMatch) text = decodeEntities(altMatch[1]);
    }
    // 일부 목록 항목은 "잘린 제목...(줄임표) + 전체 제목"을 한 앵커 안에 같이
    // 넣어둠(툴팁/접근성용 span 중복) — 줄임표 뒤의 전체 제목만 남김.
    const ellipsisIdx = text.lastIndexOf("...");
    if (ellipsisIdx !== -1 && text.length - ellipsisIdx - 3 >= 4) {
      text = text.slice(ellipsisIdx + 3).trim();
    }
    if (text.length < 4 || text.length > 200) continue;
    if (!keywordRe.test(text) || NOISE_RE.test(text)) continue;
    if (!POST_LINK_RE.test(m[1])) continue;
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

// 모집 관련 제목 여부 — KEYWORD_RE보다 좁게, "모집" 계열 공고만 recruit 후보로 봄
const RECRUIT_TITLE_RE = /(모집|신청자\s*모집|참여자\s*모집|참가업체\s*모집|셀러\s*모집)/;
// 이미 끝난 모집(결과/선정/완료) — 제목만으로 general 처리
const RESULT_TITLE_RE = /(선정\s*결과|결과\s*안내|마감되었|종료되었|성황리|마무리)/;
// 본문에서 모집/접수/신청 기간 날짜 범위 추출
const DATE_RANGE_RE =
  /(?:모집|접수|신청)\s*(?:기간|기한)?\s*[:：]?\s*(\d{4}[.\-]\s?\d{1,2}[.\-]\s?\d{1,2})\s*(?:~|-|부터)\s*(\d{4}[.\-]\s?\d{1,2}[.\-]\s?\d{1,2})/;
const ATTACHMENT_RE = /([^\s]+\.(?:hwp|pdf|jpg|jpeg|png))\s*다운로드/gi;

function parseKoDate(s) {
  const m = s.replace(/\s/g, "").match(/(\d{4})[.\-](\d{1,2})[.\-](\d{1,2})/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return isNaN(d.getTime()) ? null : d;
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchAndClassifyDetail(detailUrl, title) {
  const result = {
    applyStart: null,
    applyEnd: null,
    noticeType: "general",
    recruitStatus: "unknown",
    memo: "",
  };
  let bodyText = "";
  try {
    const html = await fetchText(detailUrl);
    bodyText = stripHtml(html);
  } catch (err) {
    result.memo = `상세페이지 접속 실패(${err.message}) — 목록 제목만으로 분류함.`;
  }

  const isResult = RESULT_TITLE_RE.test(title);
  const isRecruitTitle = RECRUIT_TITLE_RE.test(title) && !isResult;

  if (!isRecruitTitle) {
    result.noticeType = "general";
    result.recruitStatus = "unknown";
    result.memo = result.memo || "제목상 모집공고가 아니라 일반 축제 소식/결과 안내로 분류됨.";
    return result;
  }

  result.noticeType = "recruit";
  const dateMatch = bodyText.match(DATE_RANGE_RE);
  if (dateMatch) {
    const start = parseKoDate(dateMatch[1]);
    const end = parseKoDate(dateMatch[2]);
    if (start && end) {
      result.applyStart = dateMatch[1].replace(/\s/g, "");
      result.applyEnd = dateMatch[2].replace(/\s/g, "");
      const today = new Date();
      if (today < start) result.recruitStatus = "upcoming";
      else if (today > end) result.recruitStatus = "closed";
      else result.recruitStatus = "open";
    }
  }

  const attachments = [...bodyText.matchAll(ATTACHMENT_RE)].map((m) => m[1]);
  if (result.recruitStatus === "unknown") {
    result.memo = attachments.length
      ? `모집기간 등 세부정보가 본문에 없고 첨부파일(${attachments.join(", ")})에만 있을 가능성이 높음 — 원문 첨부파일을 직접 확인 후 모집중/마감 여부를 판단하세요.`
      : "모집기간을 본문에서 확인하지 못함 — 원문을 직접 확인하세요.";
  } else {
    result.memo = `본문에서 모집기간(${result.applyStart}~${result.applyEnd}) 확인됨. 참가자격·신청방법 등 세부사항은 원문/첨부파일에서 추가 확인 필요.`;
  }
  return result;
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, " ")
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
          // sha256 of the full URL, not a truncated base64 of it — URLs from the
          // same board share a long prefix, so slicing plain base64 collided across
          // different articles (fixed 2026-10-05).
          id: `gh-${require("crypto").createHash("sha256").update(c.url).digest("base64url").slice(0, 16)}`,
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

  // ---- 경주·김해 확대분: 실제 모집 여부까지 분류해서 기록 (noticeType/recruitStatus) ----
  const seenThisRunByPost = new Set(); // 같은 글이 배너+목록 등 서로 다른 URL(쿼리파라미터만 다름)로 중복 추출되는 것 방지
  for (const board of GYEONGJU_GIMHAE_BOARDS) {
    try {
      const html = await fetchText(board.url);
      const candidates = extractPostCandidates(html, board.url, NEW_SITE_KEYWORD_RE);
      perBoardCounts.push(`${board.sourceOrg}: ${candidates.length}건 매칭 (원본 앵커 ${(html.match(/<a\s/g) || []).length}개 중)`);

      for (const c of candidates) {
        if (seen[c.url]) continue;
        const u = new URL(c.url);
        const postKey = `${u.origin}${u.pathname}|${u.searchParams.get("idx") || u.searchParams.get("parm_bod_uid") || c.url}`;
        if (seenThisRunByPost.has(postKey)) continue;
        seenThisRunByPost.add(postKey);
        seen[c.url] = { firstSeen: new Date().toISOString(), org: board.org };

        const cls = await fetchAndClassifyDetail(c.url, c.title);
        newItems.push({
          id: `gh-${require("crypto").createHash("sha256").update(c.url).digest("base64url").slice(0, 16)}`,
          name: c.title,
          region: board.region,
          city: board.city,
          sourceOrg: board.sourceOrg,
          sourceUrl: c.url,
          applyStart: cls.applyStart,
          applyEnd: cls.applyEnd,
          festivalStart: null,
          festivalEnd: null,
          applyLink: null,
          fee: null,
          boothType: null,
          eligibility: null,
          ulsanEligible: "unknown",
          collectedAt: new Date().toISOString(),
          status: "pending",
          organizerType: "official",
          noticeType: cls.noticeType,
          recruitStatus: cls.recruitStatus,
          memo: `자동수집(GitHub Actions, ${board.org} — 검증된 공식 URL). ${cls.memo}`,
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
