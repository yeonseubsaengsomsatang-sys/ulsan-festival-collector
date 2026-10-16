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

// ---- 경상남도 밀양시청 보도자료 (2026-10-16 추가, 실제 fetch로 검증) ----
// 조사 결과: www.miryang.go.kr 메인의 "보도자료" 메뉴가 실제로 가리키는 목록 URL은
// /web/bbs/selectBoardList.do?bbsId=BBSMSTR_000000000356&mnNo=20100000000 (처음 추정했던
// /cop/bbs/... 경로는 전부 404 — 메뉴 링크를 직접 따라가 재확인함). 페이지 제목이
// "목록 > 보도자료"이고 페이지네이션이 939페이지까지 있어 실제 운영 중인 게시판임을 확인.
// 이 사이트의 목록 카드 마크업은 <a href="...selectBoardDetail.do..."> 하나 안에 썸네일
// 이미지(alt=제목 중복) + 제목(<span class="Br-h3tit1">) + 날짜(<span class="BrDate">)가
// 전부 중첩돼 있어, 기존 ANCHOR_RE_WIDE(500자 캡처)로는 제목 앞뒤에 다른 텍스트가 섞여
// 들어오거나 길이 제한에 걸려 추출되지 않음(실측 확인). 그래서 이 사이트 전용으로
// href(selectBoardDetail.do) · 제목(Br-h3tit1) · 날짜(BrDate)를 한 번에 짝지어 뽑는
// 전용 정규식을 따로 둠 — 실제 10건 추출 테스트에서 제목·원문링크·게시일(2026.10.15 등)이
// 전부 정상 추출됨을 확인했음.
const MIRYANG_ITEM_RE =
  /<a href="([^"]+selectBoardDetail\.do[^"]+)">[\s\S]{0,700}?Br-h3tit1">([^<]{4,200})<[\s\S]{0,700}?BrDate">([^<]{4,20})</g;

function extractMiryangCandidates(html, pageUrl) {
  const out = [];
  const re = new RegExp(MIRYANG_ITEM_RE.source, "g");
  let m;
  while ((m = re.exec(html))) {
    const title = decodeEntities(m[2]).replace(/\s+/g, " ").trim();
    if (title.length < 4 || title.length > 200) continue;
    if (!NEW_SITE_KEYWORD_RE.test(title) || NOISE_RE.test(title)) continue;
    const rawHref = m[1].replace(/;jsessionid=[^?]*/, "");
    let absUrl;
    try {
      absUrl = new URL(decodeEntities(rawHref), pageUrl).href;
    } catch {
      continue;
    }
    out.push({ title, url: absUrl, postedDate: m[3].trim() });
  }
  return out;
}

const MIRYANG_BOARDS = [1, 2, 3].map((page) => ({
  org: "경상남도 밀양시청",
  sourceOrg: "밀양시청 보도자료",
  url: `https://www.miryang.go.kr/web/bbs/selectBoardList.do?bbsId=BBSMSTR_000000000356&mnNo=20100000000&pageIndex=${page}`,
  region: "경남",
  city: "밀양",
  extractor: extractMiryangCandidates,
}));

// ---- 경상북도 영주시청 공지사항 · 경상북도 경산시청 고시공고 (2026-10-16 추가, 실제 fetch로 검증) ----
// 둘 다 경주시청과 같은 "open_content/.../page.do?mnu_uid=" CMS 계열이지만, 목록 행의 CSS
// 클래스가 배포마다 다름(영주: <td class="subject">, 경산: <td class="aL sub_tit">, 날짜 칸도
// 영주는 class="date", 경산은 class="con_rgstDateTime") — 그래서 특정 클래스 이름에 기대지
// 않고 "parm_bod_uid=가 포함된 링크의 title 속성(=항상 전체 제목이 온전히 들어있음) + 그 뒤
// 가장 가까운 YYYY-MM-DD 날짜"를 뽑는 공용 추출기로 둘 다 처리한다. title 속성을 쓰는 이유:
// 화면에 보이는 링크 텍스트는 "...긴 제목 중간에서 잘림... &nbsp;" 형태로 잘려 있어서, 잘린
// 지점 뒤에 있던 키워드(예: "...행사 개최..." 뒤의 "참가자 모집")가 통째로 사라지는 걸
// 영주시청 실제 응답으로 확인함 — title 속성에는 항상 전체 제목이 들어있어 이 문제가 없음.
// 경산 "공지사항"(mnu_uid=6055)은 실제로 받아보니 게시판 목록이 아니라 포털 메인 화면이
// 그대로 응답됨(parm_bod_uid= 링크 0개) — 추측 등록 금지 원칙에 따라 SKIPPED, 고시공고만 등록.
// 날짜 탐색 범위를 4000자로 넉넉히 둔 이유: 첨부파일이 여러 개 달린 글(영주 실측 사례 —
// 첨부 5개짜리 행)은 제목과 날짜 칸 사이에 첨부파일 목록 HTML이 2000자 넘게 끼어 있어,
// 1500자로는 그 행의 날짜를 못 찾아 해당 글 자체가 통째로 누락됐음(실측으로 발견·수정).
const OPEN_CONTENT_ITEM_RE =
  /<a href="([^"]*parm_bod_uid=[^"]*)"[^>]*title="([^"]{4,200})">[\s\S]{0,4000}?(\d{4}-\d{2}-\d{2})/g;

function extractOpenContentCandidates(html, pageUrl) {
  const out = [];
  const re = new RegExp(OPEN_CONTENT_ITEM_RE.source, "g");
  let m;
  while ((m = re.exec(html))) {
    const title = decodeEntities(m[2]).replace(/\s+/g, " ").trim();
    if (title.length < 4 || title.length > 200) continue;
    if (!NEW_SITE_KEYWORD_RE.test(title) || NOISE_RE.test(title)) continue;
    let absUrl;
    try {
      absUrl = new URL(decodeEntities(m[1]), pageUrl).href;
    } catch {
      continue;
    }
    out.push({ title, url: absUrl, postedDate: m[3] });
  }
  return out;
}

const YEONGJU_GYEONGSAN_BOARDS = [
  {
    org: "경상북도 영주시청",
    sourceOrg: "영주시청 공지사항",
    url: "https://www.yeongju.go.kr/open_content/main/page.do?mnu_uid=1521",
    region: "경북",
    city: "영주",
    extractor: extractOpenContentCandidates,
  },
  {
    org: "경상북도 경산시청",
    sourceOrg: "경산시청 고시공고",
    url: "https://www.gbgs.go.kr/open_content/ko/page.do?mnu_uid=6334",
    region: "경북",
    city: "경산",
    extractor: extractOpenContentCandidates,
  },
  // SKIPPED: 경산시청 공지사항 mnu_uid=6055 — 실제 응답이 포털 메인 화면이라 게시판 목록 없음.
];

// ---- 경상남도 창원특례시청 보도자료 (2026-10-16 추가, 실제 fetch로 검증) ----
// 카드형 목록이라 제목(<strong class="t1">)에는 실제로 "축제"라는 단어가 없는 경우가 있었음
// (실측 사례: 제목 "합성동의 가을밤, 맥주와 청춘으로 다시 들썩인다." — 실제 행사명("마산
// 합성동 젊음의 거리 맥주 축제")은 그 아래 요약문 <span class="t2">에만 등장) — 제목만 보면
// 이 글을 완전히 놓치므로, 제목+요약문을 합쳐서 키워드 판정을 한다.
// 고시공고 게시판은 카드형이 아니라 단순 표 형태라 이번엔 추출기를 따로 검증하지 못해
// SKIPPED — 보도자료만 등록.
const CHANGWON_ITEM_RE =
  /<a href="(\?[^"]*amode=view[^"]*)"[^>]*>[\s\S]{0,500}?<strong class="t1">([\s\S]{0,300}?)<\/strong>[\s\S]{0,150}?<span class="t2">([\s\S]{0,500}?)<\/span>[\s\S]{0,500}?<span class="t3">([^<]{4,20})<\/span>/g;

function extractChangwonCandidates(html, pageUrl) {
  const out = [];
  const re = new RegExp(CHANGWON_ITEM_RE.source, "g");
  let m;
  const clean = (s) => decodeEntities(s.replace(/<[^>]*>/g, "")).replace(/새\s*글/g, "").trim();
  while ((m = re.exec(html))) {
    const title = clean(m[2]);
    const summary = clean(m[3]);
    if (title.length < 4 || title.length > 200) continue;
    const combined = `${title} ${summary}`;
    if (!NEW_SITE_KEYWORD_RE.test(combined) || NOISE_RE.test(title)) continue;
    let absUrl;
    try {
      absUrl = new URL(decodeEntities(m[1]), pageUrl).href;
    } catch {
      continue;
    }
    out.push({ title, url: absUrl, postedDate: m[4].trim() });
  }
  return out;
}

const CHANGWON_BOARDS = [
  {
    org: "경상남도 창원특례시청",
    sourceOrg: "창원시청 보도자료",
    url: "https://www.changwon.go.kr/cwportal/10310/10429/10432.web",
    region: "경남",
    city: "창원",
    extractor: extractChangwonCandidates,
  },
  // SKIPPED: 창원시청 고시공고 — 보도자료와 마크업이 전혀 달라(카드형 아닌 단순 표) 이번엔
  // 추출기를 따로 검증하지 못함. 추측 등록 금지 원칙에 따라 제외.
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

// 모집 관련 제목 여부 — KEYWORD_RE보다 좁게, "모집" 계열 공고만 1차 후보로 봄
const RECRUIT_TITLE_RE = /(모집|신청자\s*모집|참여자\s*모집|참가업체\s*모집|셀러\s*모집)/;
// 실제 판매부스·체험부스·프리마켓·푸드트럭·셀러 등 "부스/상인" 모집인지 — 교육프로그램
// 참가자 모집, 자원봉사 모집, 공연팀/버스킹 모집처럼 부스와 무관한 모집과 구분하기 위한
// 좁은 키워드(2026-10-16 추가: 분류 정확도 개선 요청에 따라 신설).
const BOOTH_KEYWORD_RE =
  /(판매\s*부스|체험\s*부스|먹거리\s*부스|식음료\s*부스|프리마켓|플리마켓|푸드트럭|나눔장터|셀러\s*모집|셀러모집|부스\s*모집|부스\s*참가|부스\s*운영자|입점\s*모집|판매자\s*모집|참여상인\s*모집|참가업체\s*모집)/;
// 이미 끝난 모집/행사(결과·선정·완료·개최 종료) — 제목만으로 general 처리.
// "성료"가 빠져 있어 "OO축제 성료" 같은 종료 소식이 그대로 섞여 들어오던 문제를
// 2026-10-16에 실제 수집 결과에서 확인하고 추가함(밀양시청 테스트 중 발견).
const RESULT_TITLE_RE = /(선정\s*결과|결과\s*안내|마감되었|종료되었|성황리|성료|마무리)/;
// 본문에서 모집/접수/신청 기간 날짜 범위 추출
const DATE_RANGE_RE =
  /(?:모집|접수|신청)\s*(?:기간|기한)?\s*[:：]?\s*(\d{4}[.\-]\s?\d{1,2}[.\-]\s?\d{1,2})\s*(?:~|-|부터)\s*(\d{4}[.\-]\s?\d{1,2}[.\-]\s?\d{1,2})/;
const ATTACHMENT_RE = /([^\s]+\.(?:hwp|pdf|jpg|jpeg|png))\s*다운로드/gi;

// 부스 종류 라벨 — BOOTH_KEYWORD_RE가 왜 매치됐는지 사람이 바로 알아볼 수 있도록
// title/본문에서 가장 먼저 매치되는 패턴 하나를 골라 boothType 필드에 남긴다.
const BOOTH_TYPE_PATTERNS = [
  ["프리마켓", /프리마켓/],
  ["플리마켓", /플리마켓/],
  ["푸드트럭", /푸드트럭/],
  ["먹거리부스", /먹거리\s*부스|식음료\s*부스/],
  ["체험부스", /체험\s*부스/],
  ["판매부스", /판매\s*부스|판매자\s*모집|참여상인\s*모집/],
  ["셀러모집", /셀러\s*모집|셀러모집/],
  ["나눔장터", /나눔장터/],
  ["부스모집", /부스\s*모집|부스\s*참가|부스\s*운영자|입점\s*모집|참가업체\s*모집/],
];
function detectBoothType(text) {
  for (const [label, re] of BOOTH_TYPE_PATTERNS) {
    if (re.test(text)) return label;
  }
  return null;
}

// 제목(+가능하면 본문)을 보고 noticeType을 정하는 공통 분류기 — 기존 기관(울산·경주·김해)과
// 신규 기관(밀양) 모두 이 한 함수를 거치도록 통일해 "같은 기준"으로 분류되게 함
// (2026-10-16, 분류 정확도 개선 요청에 따라 신설).
//   - "recruit" : 판매부스·체험부스·프리마켓·푸드트럭·셀러 등 부스/상인 모집 → 우선 검토 대상
//   - "general" : 축제 개최/종료 소식, 교육 프로그램·자원봉사·공연팀 등 부스와 무관한 모집
//   - "review"  : 제목만으로 부스 모집 여부를 확정할 수 없고 본문도 애매함 → 사람이 원문 확인
function classifyNotice(title, bodyText) {
  const isResult = RESULT_TITLE_RE.test(title);
  const titleHasBooth = BOOTH_KEYWORD_RE.test(title);
  const titleHasRecruit = RECRUIT_TITLE_RE.test(title);
  const bodyHasBooth = !!bodyText && BOOTH_KEYWORD_RE.test(bodyText);

  if (isResult) {
    return {
      noticeType: "general",
      boothType: null,
      reason: "제목에 '성료/마무리/결과 안내' 등 종료성 표현이 있어 이미 끝난 소식으로 분류됨.",
    };
  }
  if (titleHasBooth && titleHasRecruit) {
    return {
      noticeType: "recruit",
      boothType: detectBoothType(title) || detectBoothType(bodyText || ""),
      reason: "제목에 판매부스/체험부스/프리마켓/셀러 등 부스 모집 키워드가 명확히 포함됨 — 우선 검토 대상.",
    };
  }
  if (titleHasRecruit && !titleHasBooth) {
    if (bodyHasBooth) {
      return {
        noticeType: "review",
        boothType: detectBoothType(bodyText),
        reason: "제목은 일반 참가자·프로그램 모집으로 보이지만 본문에 부스 관련 표현이 있어 사람 확인 필요.",
      };
    }
    return {
      noticeType: "general",
      boothType: null,
      reason: "제목상 부스/셀러 모집이 아니라 일반 참가자·교육프로그램·자원봉사 등 모집으로 분류됨.",
    };
  }
  // 제목에 "모집" 계열 단어 자체가 없는 경우
  if (bodyHasBooth) {
    return {
      noticeType: "review",
      boothType: detectBoothType(bodyText),
      reason: "제목만으로는 모집공고 여부가 불분명하지만 본문에 부스 관련 표현이 있어 사람 확인 필요.",
    };
  }
  return {
    noticeType: "general",
    boothType: null,
    reason: "제목상 모집공고가 아니라 일반 축제 개최/소식으로 분류됨.",
  };
}

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
    boothType: null,
    recruitStatus: "unknown",
    memo: "",
  };
  let bodyText = "";
  let fetchFailNote = "";
  try {
    const html = await fetchText(detailUrl);
    bodyText = stripHtml(html);
  } catch (err) {
    fetchFailNote = `상세페이지 접속 실패(${err.message}) — 본문은 확인 못 하고 제목만으로 분류함. `;
  }

  const cls = classifyNotice(title, bodyText);
  result.noticeType = cls.noticeType;
  result.boothType = cls.boothType;

  if (result.noticeType !== "recruit") {
    result.recruitStatus = "unknown";
    result.memo = `${fetchFailNote}${cls.reason}`;
    return result;
  }

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
      ? `${fetchFailNote}${cls.reason} 모집기간 등 세부정보가 본문에 없고 첨부파일(${attachments.join(", ")})에만 있을 가능성이 높음 — 원문 첨부파일을 직접 확인 후 모집중/마감 여부를 판단하세요.`
      : `${fetchFailNote}${cls.reason} 모집기간을 본문에서 확인하지 못함 — 원문을 직접 확인하세요.`;
  } else {
    result.memo = `${cls.reason} 본문에서 모집기간(${result.applyStart}~${result.applyEnd}) 확인됨. 참가자격·신청방법 등 세부사항은 원문/첨부파일에서 추가 확인 필요.`;
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

        // 2026-10-16: 경주·김해·밀양과 동일한 기준(classifyNotice)을 울산 보드에도 적용해
        // 판매부스·체험부스·프리마켓 등 실제 부스 모집만 noticeType="recruit"(우선 검토)로
        // 남기고, 축제 개최/종료 소식이나 교육·자원봉사 등 부스 무관 모집은 "general"로,
        // 제목만으로 애매하면 "review"로 구분한다. (분류 정확도 개선 요청에 따른 변경)
        const cls = await fetchAndClassifyDetail(c.url, c.title);
        newItems.push({
          // sha256 of the full URL, not a truncated base64 of it — URLs from the
          // same board share a long prefix, so slicing plain base64 collided across
          // different articles (fixed 2026-10-05).
          id: `gh-${require("crypto").createHash("sha256").update(c.url).digest("base64url").slice(0, 16)}`,
          name: c.title,
          region: "울산",
          sourceOrg: board.sourceOrg,
          sourceUrl: c.url,
          applyStart: cls.applyStart,
          applyEnd: cls.applyEnd,
          boothType: cls.boothType,
          collectedAt: new Date().toISOString(),
          status: "pending",
          organizerType: "official",
          noticeType: cls.noticeType,
          recruitStatus: cls.recruitStatus,
          memo: `자동수집(GitHub Actions, ${board.org}). ${cls.memo}`,
        });
      }
    } catch (err) {
      perBoardCounts.push(`${board.sourceOrg}: FETCH FAILED — ${err.message}`);
    }
  }

  // ---- 경주·김해·밀양·영주·경산·창원 확대분: 실제 모집 여부까지 분류해서 기록 ----
  // 사이트마다 목록 마크업이 달라 전용 추출기를 쓰는 곳이 있다(밀양/영주·경산/창원) — 그 외
  // 흐름(상세페이지 분류, dedup, 데이터 저장)은 전부 동일하게 재사용한다.
  const seenThisRunByPost = new Set(); // 같은 글이 배너+목록 등 서로 다른 URL(쿼리파라미터만 다름)로 중복 추출되는 것 방지
  for (const board of [
    ...GYEONGJU_GIMHAE_BOARDS,
    ...MIRYANG_BOARDS,
    ...YEONGJU_GYEONGSAN_BOARDS,
    ...CHANGWON_BOARDS,
  ]) {
    try {
      const html = await fetchText(board.url);
      const extractFn = board.extractor || ((h, u) => extractPostCandidates(h, u, NEW_SITE_KEYWORD_RE));
      const candidates = extractFn(html, board.url);
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
          postedDate: c.postedDate || null,
          applyStart: cls.applyStart,
          applyEnd: cls.applyEnd,
          festivalStart: null,
          festivalEnd: null,
          applyLink: null,
          fee: null,
          boothType: cls.boothType,
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
