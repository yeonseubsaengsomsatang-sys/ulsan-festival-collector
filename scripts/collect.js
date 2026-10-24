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
// 2026-10-21: 모집공고 본문에 없는 세부정보(참가비·부스크기·전기·참가자격 등)가 공식
// 첨부파일(PDF)에만 있는 경우가 실제로 매우 흔함(경주 윈터포차라이트 사례로 실측 확인).
// pdf-parse는 무료 오픈소스(MIT) 라이브러리로 외부 API 호출이 전혀 없어 이 프로젝트의
// "LLM 호출 없는 순수 HTTP+정규식" 철학에 맞음 — 비용 $0, GitHub Actions에 npm install
// 단계만 추가됨. .hwp(구 바이너리 한글파일)는 2026-10-22부터 외부 라이브러리 없이
// CFBF+HWP5 레코드 구조를 직접 해석해 지원함(extractHwp5BodyText 참고, 2026
// 울산옹기축제 플리마켓 모집 공고 실제 .hwp로 실측 검증).
const { PDFParse } = require("pdf-parse");
const zlib = require("zlib");
// 2026-10-23 신설: 북구청·동구청·남구청의 eminwon(새올전자민원) "고시공고" 목록은
// 페이지 로드 시 JS가 자동으로 서버에 POST를 보내 채우는 구조라 순수 fetch()로는
// 빈 틀만 받아진다 — 목록 "발견"에만 헤드리스 브라우저(Playwright)를 쓰고, 상세 조회·
// 분류·첨부파일 분석은 그대로 기존 순수 HTTP 로직을 재사용한다(collect-playwright.js
// 참고). playwright 자체는 그 모듈 안에서만 지연 로딩하므로, 설치가 안 된 환경에서도
// 이 기관들만 "fetch_failed"로 분리될 뿐 다른 지역 수집에는 영향이 없다.
const { fetchEminwonCandidates, buildEminwonDetailUrl, extractEminwonDetailTitle } = require("./collect-playwright.js");

const DATA_DIR = path.join(__dirname, "..", "data");
const SEEN_PATH = path.join(DATA_DIR, "seen.json");
const OUT_PATH = path.join(DATA_DIR, "collected.json");
const BOARD_STATUS_PATH = path.join(DATA_DIR, "board_status.json");

// 2026-10-21: 대형 축제/보도자료뿐 아니라 소규모 프리마켓·주말장터·벼룩시장의 셀러
// 모집공고도 놓치지 않도록 "주말장터"·"벼룩시장"을 추가(기존 "나눔장터"와 같은 성격의
// 소규모 장터 용어 — 전국 17개 시도 확대 요청에 따른 보강).
// 2026-10-23 보강: 울산쇠부리축제(북구) 실측 — "먹거리장터 운영단체 모집"처럼 "부스"
// 없이 "먹거리장터"만 쓰는 표현도 여기(게시판 단위 1차 키워드 필터)에서 걸려야
// classifyNotice까지 도달한다. 아래 BOOTH_KEYWORD_RE와 짝을 맞춤.
// 2026-10-24 보강: 요청사항 — 푸드트럭·아파트 행사·행정복지센터 주관 장터/체험부스
// 모집공고도 놓치지 않도록 추가. "아파트"·"행정복지센터"는 단독으로는 무관한 공지에도
// 흔히 등장하는 일반 명사라(예: "OO행정복지센터 민원 안내"), 뒤에 장터/체험/모집 등
// 실제 행사성 단어가 붙은 조합만 매치하도록 좁혀서 오탐을 막는다.
const KEYWORD_RE =
  /(축제|체험\s*부스|판매\s*부스|먹거리\s*부스|식음료\s*부스|먹거리\s*장터|프리마켓|플리마켓|나눔장터|주말장터|벼룩시장|셀러\s*모집|셀러모집|부스\s*모집|부스운영|부스\s*참가|판매자\s*모집|참여상인\s*모집|운영자\s*모집|참가업체\s*모집|참가자\s*모집|푸드트럭(\s*모집)?|아파트\s*(축제|행사|나눔장터|플리마켓|장터)|행정복지센터[^.\n]{0,15}(모집|장터|체험|부스|축제))/;

// Titles that structurally match the keyword regex but are almost never a
// real recruitment notice (menu labels, past-tense wrap-up articles, etc.)
const NOISE_RE = /(성황리|마무리|종료|안내드립니다$|바랍니다$|메뉴|사이트맵)/;

// 2026-10-24 신설(요청사항): "학교는 제외" — 초·중·고·대학교, 유치원, 어린이집이
// 주관/대상인 모집공고는 이 프로젝트의 수집 대상(축제·프리마켓·먹거리장터·행정복지센터·
// 아파트 행사·푸드트럭·판매부스·체험부스)이 아니므로, 제목에 학교 관련 단어가 있으면
// 다른 키워드와 매치되더라도 최종적으로 걸러낸다(예: "OO고등학교 축제 체험부스 모집").
const SCHOOL_EXCLUDE_RE = /(유치원|어린이집|초등학교|중학교|고등학교|대학교|학교)/;

const KEYWORDS_FOR_SEARCH = ["축제", "부스", "셀러", "프리마켓", "체험부스", "판매부스", "모집"];

const BOARDS = [
  // ---- 북구청 (VERIFIED 2026-09-24: raw HTML confirmed server-rendered) ----
  // 2026-10-24 신설: city 필드 추가 — 홈페이지 "시·군·구" 필터(북구 전용 보기)가
  // 이 값으로 걸러낸다. 게시판을 운영하는 기관이 명확히 특정 구·군 소속일 때만
  // 채움(울산시청처럼 시 전체 공지는 특정 구·군으로 단정할 수 없어 비워둠).
  { org: "울산광역시 북구청", sourceOrg: "북구청 알림사항", url: "https://www.bukgu.ulsan.kr/lay1/bbs/S1T62C83/A/1/list.do", city: "북구" },
  { org: "울산광역시 북구청", sourceOrg: "북구청 북구공보", url: "https://www.bukgu.ulsan.kr/lay1/bbs/S1T1903C104/A/1/list.do", city: "북구" },
  { org: "울산광역시 북구청", sourceOrg: "북구청 타기관소식", url: "https://www.bukgu.ulsan.kr/lay1/bbs/S1T62C101/A/1/list.do", city: "북구" },

  // ---- 중구청 (INFERRED: view.ulsan -> list.ulsan by the site's own naming convention) ----
  { org: "울산광역시 중구청", sourceOrg: "중구청 새소식", url: "https://www.junggu.ulsan.kr/board/list.ulsan?boardId=BBS_0000057&menuCd=DOM_000000102003001000&paging=ok&startPage=1", city: "중구" },

  // ---- 동구청 (FIXED 2026-10-05: ?searchWrd= does nothing — the site's real search
  // submits via POST with a CSRF token, so GET keyword search was silently returning
  // the same unfiltered page 1 every time. Switched to plain multi-page listing
  // (like 북구청) so the existing local keyword regex has real content to scan.) ----
  ...["BBSMSTR_000000000323", "BBSMSTR_000000000322"].flatMap((bbsId) =>
    [1, 2, 3].map((page) => ({
      org: "울산광역시 동구청",
      sourceOrg: bbsId === "BBSMSTR_000000000323" ? "동구청 알림사항" : "동구청 보도자료",
      url: `https://www.donggu.ulsan.kr/cop/bbs/selectBoardList.do?bbsId=${bbsId}&pageIndex=${page}`,
      city: "동구",
    }))
  ),

  // ---- 남구청 (FIXED 2026-10-05: bbsId=namguNews is a traffic/tax/civil-affairs board —
  // checked 18 pages back, zero festival-related posts. bbsId=press (보도자료) actually
  // carries them, e.g. "고래문화재단, 제30회 울산고래축제 자원봉사 활동가 모집".) ----
  ...[1, 2, 3].map((page) => ({
    org: "울산광역시 남구청",
    sourceOrg: "남구청 보도자료",
    url: `https://www.ulsannamgu.go.kr/cop/bbs/selectBoardList.do?bbsId=press&pageIndex=${page}`,
    city: "남구",
  })),

  // ---- 울주군청 (VERIFIED working search endpoint per site testing 2026-09-24) ----
  ...KEYWORDS_FOR_SEARCH.map((kw) => ({
    org: "울산광역시 울주군청",
    sourceOrg: "울주군청 통합검색",
    url: `https://www.ulju.ulsan.kr/search/front/Search.jsp?searchKey=total&qt=${encodeURIComponent(kw)}`,
    city: "울주",
  })),

  // ---- 울산광역시청 (INFERRED: bbs/view.do -> bbs/list.do convention) ----
  { org: "울산광역시청", sourceOrg: "울산시청 울산소식", url: "https://www.ulsan.go.kr/u/rep/bbs/list.do?bbsId=BBS_0000000000000003&mId=001004001001000000" },

  // ---- 북구청·동구청·남구청 고시공고(eminwon) — 2026-10-23: 목록 발견용 헤드리스
  // 브라우저 + 상세조회용 고정 GET URL 조합으로 해결(EMINWON_PLAYWRIGHT_BOARDS 참고).
  // 과거엔 "POST/세션 필요"로 제외했던 보드였음.
];

// 2026-10-23 신설: 북구청·동구청·남구청 eminwon "고시공고" 목록 — 일반 BOARDS와 달리
// 목록 자체를 Playwright로 렌더링해야 해서(위 require 주석 참고) main()의 기존 두
// 반복문과는 별도의 세 번째 루프로 처리한다. ALL_BOARDS(진단 스크립트가 "board.url을
// 그대로 fetch 가능"하다고 가정하고 쓰는 목록)에는 포함하지 않음 — 이 보드들은 목록
// 발견에 Playwright가 필요해 그 가정이 깨지기 때문.
const EMINWON_PLAYWRIGHT_BOARDS = [
  { org: "울산광역시 북구청", sourceOrg: "북구청 고시공고(eminwon)", host: "eminwon.bukgu.ulsan.kr", city: "북구" },
  { org: "울산광역시 동구청", sourceOrg: "동구청 고시공고(eminwon)", host: "eminwon.donggu.ulsan.kr", city: "동구" },
  { org: "울산광역시 남구청", sourceOrg: "남구청 고시공고(eminwon)", host: "eminwon.ulsannamgu.go.kr", city: "남구" },
].map((b) => ({ ...b, region: "울산", listUrl: `https://${b.host}/emwp/jsp/ofr/OfrNotAncmtLSub.jsp` }));

// 2026-10-23 신설: 북구청 산하 행사 주관기관(울산쇠부리축제추진위원회) 공식 공지사항 —
// 순수 HTTP로 서버 렌더링되는 일반 게시판이라(extractSoeburiCandidates 참고) 아래
// main()의 두 번째 반복문(board.extractor 쓰는 쪽)에 다른 신규 사이트들과 함께 들어감.
const BUKGU_FESTIVAL_BOARDS = [
  {
    org: "울산쇠부리축제추진위원회",
    sourceOrg: "쇠부리축제 공지사항(북구)",
    url: "https://soeburi.org/Notice",
    region: "울산",
    city: "북구",
    extractor: extractSoeburiCandidates,
  },
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
// 2026-10-22 수정: 경주시청의 3개 게시판(공지사항·고시공고·신라문화제)은 영주·경산과
// 완전히 같은 "open_content/.../page.do?mnu_uid=" CMS(parm_bod_uid= 링크 + title 속성 +
// 근처 YYYY-MM-DD 날짜)라는 게 실제 fetch로 재확인됨(OPEN_CONTENT_ITEM_RE가 그대로
// 매치됨) — 그런데도 처음 추가할 때(2026-10-15) extractor를 지정하지 않아 기본
// extractPostCandidates()가 쓰였고, 이 기본 추출기는 postedDate를 전혀 뽑지 않음.
// 그래서 "접수기간: 공고일 ~ M.D"(공고일을 postedDate로 추론하는 extractDateRange의
// APPLY_PERIOD_ANNOUNCE_RE 분기)가 postedDate 없이는 시작일을 못 메워 "확인 필요"로
// 남는 사례가 실제로 있었음(윈터포차라이트 음식부스 모집 — 참가자격·마감일·장소·참가비는
// PDF에서 정상 추출됐는데 postedDate가 없어 시작일만 비어 있었음). extractor를 명시해
// postedDate를 채워주면, 앞으로 수집되는 글은 이 분기가 실제 시작일까지 확정할 수 있다.
const GYEONGJU_GIMHAE_BOARDS = [
  {
    org: "경주시청",
    sourceOrg: "경주시청 공지사항",
    url: "https://www.gyeongju.go.kr/open_content/ko/page.do?mnu_uid=416",
    region: "경북",
    city: "경주",
    extractor: extractOpenContentCandidates,
  },
  {
    org: "경주시청",
    sourceOrg: "경주시청 고시공고",
    url: "https://www.gyeongju.go.kr/open_content/ko/page.do?mnu_uid=423",
    region: "경북",
    city: "경주",
    extractor: extractOpenContentCandidates,
  },
  {
    org: "신라문화제추진위원회",
    sourceOrg: "신라문화제 공식사이트 공지사항",
    url: "https://www.gyeongju.go.kr/sillafestival/page.do?mnu_uid=1895",
    region: "경북",
    city: "경주",
    extractor: extractOpenContentCandidates,
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
    const title = cleanTitle(decodeEntities(m[2]).replace(/\s+/g, " ").trim());
    if (title.length < 4 || title.length > 200) continue;
    if (!NEW_SITE_KEYWORD_RE.test(title) || NOISE_RE.test(title)) continue;
    const rawHref = m[1].replace(/;jsessionid=[^?]*/, "");
    let absUrl;
    try {
      const u = new URL(decodeEntities(rawHref), pageUrl);
      // 2026-10-16 수정: pageIndex는 "지금 몇 페이지에서 봤는지"일 뿐 글의 정체성과
      // 무관한데, 이 게시판은 날짜순이라 새 글이 쌓이면 같은 글이 다음 실행 때 다른
      // pageIndex로 밀려 다른 URL(=다른 id)로 다시 "신규"로 잡히는 실제 중복 수집
      // 버그가 있었음(nttId=198627 글이 pageIndex=2 -> 3으로 밀리며 중복 수집된 걸
      // 재시도 기능 테스트 중 실측으로 발견). nttId가 글의 진짜 식별자이므로
      // pageIndex는 URL에서 제거해 항상 같은 URL(=같은 id)이 나오게 고정한다.
      u.searchParams.delete("pageIndex");
      absUrl = u.href;
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
    const title = cleanTitle(decodeEntities(m[2]).replace(/\s+/g, " ").trim());
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

// ---- 경상남도 창원특례시청·진주시청 보도자료 (2026-10-16 추가, 실제 fetch로 검증) ----
// 둘 다 같은 "카드형" CMS(클래스명까지 완전히 동일: wrap1/a1/t1/t2/wrap1t3/t3)를 쓴다.
// 카드형 목록이라 제목(<strong class="t1">)에는 실제로 "축제"라는 단어가 없는 경우가 있었음
// (실측 사례: 창원 "합성동의 가을밤, 맥주와 청춘으로 다시 들썩인다." — 실제 행사명("마산
// 합성동 젊음의 거리 맥주 축제")은 그 아래 요약문 <span class="t2">에만 등장) — 제목만 보면
// 이 글을 완전히 놓치므로, 제목+요약문을 합쳐서 키워드 판정을 한다.
// 윈도우 크기(800/1000/2000/800/800)를 넉넉히 둔 이유: 진주시청 글 중 첨부파일 아이콘
// (<img>)이 여러 개 달린 행은 제목(<strong class="t1">) 안에만 공백 포함 790자가 들어있어
// 처음에 쓰던 더 좁은 창(500/300/150/500)으로는 통째로 매치 실패했음(실측으로 발견·수정).
// 고시공고 게시판(창원)은 카드형이 아니라 단순 표 형태라 이번엔 추출기를 따로 검증하지 못해
// SKIPPED — 보도자료만 등록.
const CHANGWON_ITEM_RE =
  /<a href="(\?[^"]*amode=view[^"]*)"[^>]*>[\s\S]{0,800}?<strong class="t1">([\s\S]{0,1000}?)<\/strong>[\s\S]{0,2000}?<span class="t2">([\s\S]{0,800}?)<\/span>[\s\S]{0,800}?<span class="t3">([^<]{4,20})<\/span>/g;

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
  {
    org: "경상남도 진주시청",
    sourceOrg: "진주시청 보도자료",
    url: "https://www.jinju.go.kr/00138.web",
    region: "경남",
    city: "진주",
    extractor: extractChangwonCandidates,
  },
  // SKIPPED: 창원시청 고시공고 — 보도자료와 마크업이 전혀 달라(카드형 아닌 단순 표) 이번엔
  // 추출기를 따로 검증하지 못함. 추측 등록 금지 원칙에 따라 제외.

  // ---- 2026-10-18 전국 확대: 창원·진주와 완전히 동일한 카드형 CMS(class="t1"/"t2"/"t3")를
  // 쓰는 것으로 실제 fetch + 정규식 매치로 검증된 5개 기관 추가. 검증 과정에서 창녕군청은
  // class="t3"(날짜) 자체가 없어 매치 0건으로 확인되어 제외했고(추측 등록 금지), 군위·의성은
  // 이전 조사에서 "같은 CMS일 것"으로 추정됐던 URL이 실제로는 parm_bod_uid= 링크가 전혀
  // 없는 다른 페이지로 확인되어 역시 제외함 — 반드시 실제 응답을 받아 매치 건수를 확인한
  // 기관만 등록.
  {
    org: "경상남도 통영시청",
    sourceOrg: "통영시청 보도자료",
    url: "https://www.tongyeong.go.kr/00852/00853/00859.web",
    region: "경남",
    city: "통영",
    extractor: extractChangwonCandidates,
  },
  {
    org: "경상남도 사천시청",
    sourceOrg: "사천시청 보도자료",
    url: "https://www.sacheon.go.kr/news/00009/00010.web",
    region: "경남",
    city: "사천",
    extractor: extractChangwonCandidates,
  },
  {
    org: "경상남도 함안군청",
    sourceOrg: "함안군청 보도자료",
    url: "https://www.haman.go.kr/00956/00958.web",
    region: "경남",
    city: "함안",
    extractor: extractChangwonCandidates,
  },
  {
    org: "경상남도 함양군청",
    sourceOrg: "함양군청 보도자료",
    url: "https://www.hygn.go.kr/01997/02007.web",
    region: "경남",
    city: "함양",
    extractor: extractChangwonCandidates,
  },
  {
    org: "경상남도 합천군청",
    sourceOrg: "합천군청 보도자료",
    url: "https://www.hc.go.kr/04923/04924/04953.web",
    region: "경남",
    city: "합천",
    extractor: extractChangwonCandidates,
  },
];

// ---- 경상남도 하동군청 보도자료 (2026-10-16 추가, 실제 fetch로 검증) ----
// 창원·진주와 같은 CMS 계열(URL에 amode=view)이지만 화면 스킨이 전혀 다름 — 카드형이
// 아니라 단순 표(<td class="tal"><a href="?...amode=view...">제목<i>새 글</i></a></td>,
// 그 다음다음 칸에 날짜 <td>YYYY-MM-DD</td>)라 전용 추출기를 따로 둠(영주/경산이 같은
// open_content CMS인데도 클래스명이 서로 달랐던 것과 같은 패턴).
const HADONG_ITEM_RE =
  /<a href="(\?[^"]*amode=view[^"]*)">([\s\S]{0,400}?)<\/a>[\s\S]{0,800}?(\d{4}-\d{2}-\d{2})/g;

function extractHadongCandidates(html, pageUrl) {
  const out = [];
  const re = new RegExp(HADONG_ITEM_RE.source, "g");
  let m;
  while ((m = re.exec(html))) {
    const title = decodeEntities(m[2].replace(/<[^>]*>/g, "")).replace(/새\s*글/g, "").replace(/\s+/g, " ").trim();
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

const HADONG_BOARDS = [
  {
    org: "경상남도 하동군청",
    sourceOrg: "하동군청 보도자료",
    url: "https://www.hadong.go.kr/media/00013/03607.web",
    region: "경남",
    city: "하동",
    extractor: extractHadongCandidates,
  },
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

// ---- 2026-10-18 전국 확대 1단계: 충북도청·제주 서귀포시청·인천광역시청 (실제 fetch +
// 정규식 매치 테스트로 각 10건씩 검증 완료, 울산·경남·경북과 전혀 다른 CMS라 신규
// 추출기 3종을 새로 만듦). 이 3곳은 이전 조사(전국 14개 시도 약 30개 기관 조사)에서
// 유일하게 "정적 HTML에 깨끗한 글 목록 패턴이 있다"고 확인된 곳들 — 나머지 지역
// (수도권 대부분은 JS로 목록을 그려서 fetch로는 글 목록 자체가 안 보임, 강원·충청·호남·
// 부산·대구는 각각 또 다른 CMS)는 이번 단계에서 다루지 못함.

// 충북도청 보도자료: selectBbsNttList.do(목록)/selectBbsNttView.do(상세) 계열,
// 제목은 <span class="p-table__text">, 날짜는 <time datetime="YYYY-MM-DD">.
const CHUNGBUK_ITEM_RE =
  /<a href="(\.\/selectBbsNttView\.do\?[^"]*nttNo=\d+[^"]*)"[^>]*>[\s\S]{0,500}?<span class="p-table__text">([^<]{4,200})<\/span>[\s\S]{0,500}?<time datetime="(\d{4}-\d{2}-\d{2})">/g;

function extractChungbukCandidates(html, pageUrl) {
  const out = [];
  const re = new RegExp(CHUNGBUK_ITEM_RE.source, "g");
  let m;
  while ((m = re.exec(html))) {
    const title = cleanTitle(decodeEntities(m[2]).replace(/\s+/g, " ").trim());
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

// 제주 서귀포시청 보도자료: 블로그형 목록(<p class="title"><a>제목</a></p> ...
// <p class="date"> 부서명 | YYYY-MM-DD</p>).
const SEOGWIPO_ITEM_RE =
  /<p class="title"><a href="([^"]*act=view[^"]*)">([^<]{4,200})<\/a><\/p>[\s\S]{0,1500}?<p class="date">[^|]*\|\s*(\d{4}-\d{2}-\d{2})<\/p>/g;

function extractSeogwipoCandidates(html, pageUrl) {
  const out = [];
  const re = new RegExp(SEOGWIPO_ITEM_RE.source, "g");
  let m;
  while ((m = re.exec(html))) {
    const title = cleanTitle(decodeEntities(m[2]).replace(/\s+/g, " ").trim());
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

// 인천광역시청 보도자료: repSeq= 파라미터 게시판뷰형, 제목은
// <strong class="subject">, 날짜는 <dt>제공일자</dt><dd>YYYY-MM-DD</dd>.
const INCHEON_ITEM_RE =
  /<a href="([^"]*repSeq=[^"]*)">[\s\S]{0,500}?<strong class="subject">([^<]{4,200})<\/strong>[\s\S]{0,800}?<dt>제공일자<\/dt>\s*<dd>(\d{4}-\d{2}-\d{2})<\/dd>/g;

function extractIncheonCandidates(html, pageUrl) {
  const out = [];
  const re = new RegExp(INCHEON_ITEM_RE.source, "g");
  let m;
  while ((m = re.exec(html))) {
    const title = cleanTitle(decodeEntities(m[2]).replace(/\s+/g, " ").trim());
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

// 강원특별자치도청 보도자료: eGovFrame 계열, <td class="skinTb-sbj"><a>제목</a></td>,
// 날짜는 <td class="skinTb-date">YYYY-MM-DD</td> (실제 fetch로 15/15건 매치 검증).
const GANGWON_ITEM_RE =
  /<td class="skinTb-sbj"><a href="([^"]*seq=\d+[^"]*)">\s*([^<]{4,200}?)\s*<\/a><\/td>[\s\S]{0,300}?<td class="skinTb-date">(\d{4}-\d{2}-\d{2})<\/td>/g;

function extractGangwonCandidates(html, pageUrl) {
  const out = [];
  const re = new RegExp(GANGWON_ITEM_RE.source, "g");
  let m;
  while ((m = re.exec(html))) {
    const title = cleanTitle(decodeEntities(m[2]).replace(/\s+/g, " ").trim());
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

// ---- 2026-10-18 전국 확대 2단계: 서울 3개 구(강남·송파·마포), 경기 3개 시(용인·화성·
// 남양주), 세종시청, 충남 보령시청, 전북 군산시청, 전남 목포시청 — 10개 기관 전부 실제
// fetch + 정규식 매치로 직접 검증(각 8~16건) 후 등록. CMS가 전부 제각각이라 추출기도
// 전부 따로 둠 — 같은 "전자정부" 계열이라도 스킨(클래스명)이 다르면 매치가 전혀 안 되는
// 경우가 많다는 걸 이번 단계에서도 재확인함(예: 남양주는 충북과 URL 파라미터 구조는 같지만
// 스킨이 달라 별도 정규식이 필요했음).

// 강남구청: /board/B_NNNNNN/NNNNNNN/view.do, 날짜는 바로 다음 <td>YYYY-MM-DD</td>.
const GANGNAM_ITEM_RE =
  /<a href="(\/board\/B_\d+\/\d+\/view\.do[^"]*)"[^>]*>\s*([^<]{4,200}?)\s*<\/a>[\s\S]{0,600}?<td>(\d{4}-\d{2}-\d{2})<\/td>/g;
function extractGangnamCandidates(html, pageUrl) {
  const out = [];
  const re = new RegExp(GANGNAM_ITEM_RE.source, "g");
  let m;
  while ((m = re.exec(html))) {
    const title = cleanTitle(decodeEntities(m[2]).replace(/\s+/g, " ").trim());
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

// 2026-10-23 신설: 울산쇠부리축제추진위원회(북구청 산하, soeburi.org) 공지사항 —
// XpressEngine 계열 CMS. 목록은 순수 HTTP로 서버 렌더링됨(실측: 북구청 다른 공지
// 게시판과 달리 Playwright 불필요). <td class="title"><a href="/Notice/ID...">제목</a>
// ... <td class="time">YYYY-MM-DD</td> 구조. 실제 "먹거리장터 운영단체 모집 공고",
// "철철철문화장터(프리마켓) 셀러 모집 공고", "생활문화예술제 나눔장터 참여자 모집" 등
// 부스/셀러 모집공고가 실제로 이 게시판에 올라옴을 확인하고 등록함(본문은 포스터
// 이미지뿐이라 날짜·참가비 등 세부항목은 못 뽑을 수 있음 — 그 경우에도 noticeType만
// 확실하면 날짜 미확인 상태로 노출해 셀러가 원문을 직접 확인하게 하는 기존 동작을
// 그대로 따름). 공고 상세 안의 첨부 .hwp(신청서)는 기존 fetchHwpText로 그대로 읽힘.
const SOEBURI_ITEM_RE =
  /<td class="title">\s*<a href="(\/Notice\/\d+)[^"]*">([^<]+)<\/a>\s*<\/td>[\s\S]{0,300}?<td class="time">(\d{4}-\d{2}-\d{2})<\/td>/g;
function extractSoeburiCandidates(html, pageUrl) {
  const out = [];
  const re = new RegExp(SOEBURI_ITEM_RE.source, "g");
  let m;
  while ((m = re.exec(html))) {
    const title = cleanTitle(decodeEntities(m[2]).replace(/\s+/g, " ").trim());
    if (title.length < 4 || title.length > 200) continue;
    if (!NEW_SITE_KEYWORD_RE.test(title) || NOISE_RE.test(title)) continue;
    let absUrl;
    try {
      absUrl = new URL(m[1], pageUrl).href;
    } catch {
      continue;
    }
    out.push({ title, url: absUrl, postedDate: m[3] });
  }
  return out;
}

// 송파구청: class="p-subject" 안의 selectBbsNttView.do 링크, 날짜는 그 뒤 <span>YYYY.MM.DD.
const SONGPA_ITEM_RE =
  /class="p-subject">[\s\S]{0,300}?<a href="(\.\/selectBbsNttView\.do\?[^"]*nttNo=\d+[^"]*)"[^>]*>[\s\S]{0,50}?([^<]{4,200}?)\s*(?:<span class="p-icon[^>]*>[^<]*<\/span>)?\s*<\/a>[\s\S]{0,900}?<span>\s*(\d{4})\.(\d{2})\.(\d{2})/g;
function extractSongpaCandidates(html, pageUrl) {
  const out = [];
  const re = new RegExp(SONGPA_ITEM_RE.source, "g");
  let m;
  while ((m = re.exec(html))) {
    const title = cleanTitle(decodeEntities(m[2]).replace(/\s+/g, " ").trim());
    if (title.length < 4 || title.length > 200) continue;
    if (!NEW_SITE_KEYWORD_RE.test(title) || NOISE_RE.test(title)) continue;
    let absUrl;
    try {
      absUrl = new URL(decodeEntities(m[1]), pageUrl).href;
    } catch {
      continue;
    }
    out.push({ title, url: absUrl, postedDate: `${m[3]}-${m[4]}-${m[5]}` });
  }
  return out;
}

// 마포구청: class="s-line2" 링크(/board/press/NNNNNN?...), 날짜는 YYYY.MM.DD(상세 페이지에서
// 재확인 필요 — 목록에서는 날짜 위치가 불안정해 이번엔 postedDate를 비워둠, noticeType 분류는
// fetchAndClassifyDetail이 본문을 다시 받아서 처리하므로 지장 없음).
const MAPO_ITEM_RE =
  /<a href="([^"]*\/board\/press\/\d+\?[^"]*)"[^>]*class="s-line2">\s*([^<]{4,200}?)\s*<\/a>/g;
function extractMapoCandidates(html, pageUrl) {
  const out = [];
  const re = new RegExp(MAPO_ITEM_RE.source, "g");
  let m;
  while ((m = re.exec(html))) {
    const title = cleanTitle(decodeEntities(m[2]).replace(/\s+/g, " ").trim());
    if (title.length < 4 || title.length > 200) continue;
    if (!NEW_SITE_KEYWORD_RE.test(title) || NOISE_RE.test(title)) continue;
    let absUrl;
    try {
      absUrl = new URL(decodeEntities(m[1]), pageUrl).href;
    } catch {
      continue;
    }
    out.push({ title, url: absUrl, postedDate: null });
  }
  return out;
}

// 용인특례시청: OpenWorks형, BD_selectBbs.do?...q_bbscttSn=, 날짜는 <dd class="binfo"><li>.
const YONGIN_ITEM_RE =
  /<a href="(BD_selectBbs\.do\?[^"]*q_bbscttSn=\d+[^"]*)"[^>]*>([^<]{4,200})<\/a>[\s\S]{0,600}?<dd class="binfo">[\s\S]{0,200}?<li>(\d{4}-\d{2}-\d{2})<\/li>/g;
function extractYonginCandidates(html, pageUrl) {
  const out = [];
  const re = new RegExp(YONGIN_ITEM_RE.source, "g");
  let m;
  while ((m = re.exec(html))) {
    const title = cleanTitle(decodeEntities(m[2]).replace(/\s+/g, " ").trim());
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

// 화성특례시청: 용인과 같은 OpenWorks 계열이지만 스킨이 달라 날짜가
// <td data-cell-header="등록일자 : ">에 들어있음.
const HWASEONG_ITEM_RE =
  /<a href="([^"]*BD_selectBbs\.do\?[^"]*q_bbscttSn=\d+[^"]*)">([^<]{4,200})<\/a>[\s\S]{0,300}?<td data-cell-header="등록일자 : ">(\d{4}-\d{2}-\d{2})/g;
function extractHwaseongCandidates(html, pageUrl) {
  const out = [];
  const re = new RegExp(HWASEONG_ITEM_RE.source, "g");
  let m;
  while ((m = re.exec(html))) {
    const title = cleanTitle(decodeEntities(m[2]).replace(/\s+/g, " ").trim());
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

// 남양주시청: URL 파라미터는 충북형과 같은 selectBbsNttList/View.do?key=&bbsNo= 계열이지만
// 스킨이 달라 제목은 <em class="p-media__heading-text">, 날짜는 <time class="p-split">.
const NAMYANGJU_ITEM_RE =
  /<a href="(\.\/selectBbsNttView\.do\?[^"]*nttNo=\d+[^"]*)"[^>]*>[\s\S]{0,800}?<em class="p-media__heading-text">\s*([^<]{4,200}?)\s*<\/em>[\s\S]{0,300}?<time class="p-split">(\d{4}-\d{2}-\d{2})<\/time>/g;
function extractNamyangjuCandidates(html, pageUrl) {
  const out = [];
  const re = new RegExp(NAMYANGJU_ITEM_RE.source, "g");
  let m;
  while ((m = re.exec(html))) {
    const title = cleanTitle(decodeEntities(m[2]).replace(/\s+/g, " ").trim());
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

// 세종특별자치시청: <a href="/bbs/R0071/view.do?nttId=...">제목</a>, 날짜는 한참 뒤
// <td data-cell-header="등록일">YYYY-MM-DD</td>(제목·작성자·조회수 칸을 지나야 해서
// 탐색 범위를 3200자로 넉넉히 둠 — 실측상 title~date 거리 약 2700자).
const SEJONG_ITEM_RE =
  /<a href="(\/bbs\/R0071\/view\.do\?nttId=[^"]*)"[^>]*>[\s\S]{0,50}?([^<]{4,200}?)<\/a>[\s\S]{0,3200}?<td data-cell-header="등록일">(\d{4}-\d{2}-\d{2})<\/td>/g;
function extractSejongCandidates(html, pageUrl) {
  const out = [];
  const re = new RegExp(SEJONG_ITEM_RE.source, "g");
  let m;
  while ((m = re.exec(html))) {
    const title = cleanTitle(decodeEntities(m[2]).replace(/\s+/g, " ").trim());
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

// 충남 보령시청: 울산 동구청과 유사한 전자정부 selectBoardArticle.do?...nttId= 계열,
// 날짜는 <td class="date">.
const BORYEONG_ITEM_RE =
  /<a href="([^"]*selectBoardArticle\.do[^"]*nttId=\d+[^"]*)">([\s\S]{0,300}?)<\/a>[\s\S]{0,400}?<td class="date">(\d{4}-\d{2}-\d{2})<\/td>/g;
function extractBoryeongCandidates(html, pageUrl) {
  const out = [];
  const re = new RegExp(BORYEONG_ITEM_RE.source, "g");
  let m;
  while ((m = re.exec(html))) {
    const title = decodeEntities(m[2].replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
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

// 전북 군산시청: /main/m140/view/NNNNNNN? 링크, 날짜는 2자리 연도(YY.MM.DD) — 20XX로 보정.
const GUNSAN_ITEM_RE =
  /<a href="(\/main\/m140\/view\/\d+\?)">([^<]{4,200})<\/a>[\s\S]{0,600}?<td>(\d{2})\.(\d{2})\.(\d{2})<\/td>/g;
function extractGunsanCandidates(html, pageUrl) {
  const out = [];
  const re = new RegExp(GUNSAN_ITEM_RE.source, "g");
  let m;
  while ((m = re.exec(html))) {
    const title = cleanTitle(decodeEntities(m[2]).replace(/\s+/g, " ").trim());
    if (title.length < 4 || title.length > 200) continue;
    if (!NEW_SITE_KEYWORD_RE.test(title) || NOISE_RE.test(title)) continue;
    let absUrl;
    try {
      absUrl = new URL(decodeEntities(m[1]), pageUrl).href;
    } catch {
      continue;
    }
    out.push({ title, url: absUrl, postedDate: `20${m[3]}-${m[4]}-${m[5]}` });
  }
  return out;
}

// 전남 목포시청: idx=&mode=view 링크, 제목은 <h3>, 날짜는 <dd class="date">.
const MOKPO_ITEM_RE =
  /<a href="([^"]*idx=\d+&amp;mode=view)"[^>]*>[\s\S]{0,400}?<h3>([^<]{4,200})<span[\s\S]{0,800}?<dd class="date">(\d{4}-\d{2}-\d{2})<\/dd>/g;
function extractMokpoCandidates(html, pageUrl) {
  const out = [];
  const re = new RegExp(MOKPO_ITEM_RE.source, "g");
  let m;
  while ((m = re.exec(html))) {
    const title = cleanTitle(decodeEntities(m[2]).replace(/\s+/g, " ").trim());
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

const NATIONWIDE_PHASE2_BOARDS = [
  {
    org: "서울특별시 강남구청",
    sourceOrg: "강남구청 보도자료",
    url: "https://www.gangnam.go.kr/board/B_000031/list.do?mid=ID01_0313",
    region: "서울",
    city: "강남",
    extractor: extractGangnamCandidates,
  },
  {
    org: "서울특별시 송파구청",
    sourceOrg: "송파구청 보도자료",
    url: "https://www.songpa.go.kr/www/selectBbsNttList.do?bbsNo=96&key=2781",
    region: "서울",
    city: "송파",
    extractor: extractSongpaCandidates,
  },
  {
    org: "서울특별시 마포구청",
    sourceOrg: "마포구청 보도자료",
    url: "https://www.mapo.go.kr/site/main/board/press",
    region: "서울",
    city: "마포",
    extractor: extractMapoCandidates,
  },
  {
    org: "경기도 용인특례시청",
    sourceOrg: "용인특례시청 보도자료",
    url: "https://www.yongin.go.kr/user/bbs/BD_selectBbsList.do?q_bbsCode=1020",
    region: "경기",
    city: "용인",
    extractor: extractYonginCandidates,
  },
  {
    org: "경기도 화성특례시청",
    sourceOrg: "화성특례시청 보도자료",
    url: "https://www.hscity.go.kr/www/user/bbs/BD_selectBbsList.do?q_bbsCode=1051",
    region: "경기",
    city: "화성",
    extractor: extractHwaseongCandidates,
  },
  {
    org: "경기도 남양주시청",
    sourceOrg: "남양주시청 보도자료",
    url: "https://www.nyj.go.kr/www/selectBbsNttList.do?key=2498&bbsNo=68",
    region: "경기",
    city: "남양주",
    extractor: extractNamyangjuCandidates,
  },
  {
    org: "세종특별자치시청",
    sourceOrg: "세종시청 공지사항",
    url: "https://www.sejong.go.kr/bbs/R0071/list.do",
    region: "세종",
    city: "세종",
    extractor: extractSejongCandidates,
  },
  {
    org: "충청남도 보령시청",
    sourceOrg: "보령시청 시정소식",
    url: "https://www.brcn.go.kr/cop/bbs/BBSMSTR_000000000263/selectBoardList.do",
    region: "충남",
    city: "보령",
    extractor: extractBoryeongCandidates,
  },
  {
    org: "전라북도 군산시청",
    sourceOrg: "군산시청 고시공고",
    url: "https://www.gunsan.go.kr/main/m140",
    region: "전북",
    city: "군산",
    extractor: extractGunsanCandidates,
  },
  {
    org: "전라남도 목포시청",
    sourceOrg: "목포시청 보도자료",
    url: "https://www.mokpo.go.kr/www/mokpo_news/press_release/report_material",
    region: "전남",
    city: "목포",
    extractor: extractMokpoCandidates,
  },
];

// ---- 2026-10-19 전국 확대 3단계: 광역시 4곳(부산·대구·광주·대전) 추가 — 이걸로 17개
// 시도 전체(서울·부산·대구·인천·광주·대전·울산·세종·경기·강원·충북·충남·전북·전남·경북·
// 경남·제주) 중 최소 1개 기관 이상을 커버하게 됨. 역시 실제 fetch + 정규식 매치로 직접
// 검증 후 등록(각 6~15건) — 추측 등록 없음.
//   - 대구는 주의가 필요했음: 검색으로 먼저 찾은 "보도자료"(mkey=26) 게시판은 제목이 전부
//     "대구광역시 보도자료(YYYY-MM-DD)" 형태로 통일돼 있고 실제 개별 기사 제목은 첨부
//     .hwp 파일 안에만 있어 정규식으로 못 읽음(김해시청과 같은 유형) — SKIPPED하고, 대신
//     같은 뉴스룸의 "시정소식"(mkey=2) 게시판으로 바꿈. 여긴 기사마다 실제 제목이
//     <p class="title">에 개별로 들어있어 VERIFIED.

// 부산광역시청: /nbtnews/NNNNNNN?... 링크, 제목은 같은 <td class="...title">, 날짜는
// 바로 다음 <td class="pc_Y ta_Y mo_Y nowrap">.
const BUSAN_ITEM_RE =
  /<td class="pc_Y ta_Y mo_Y title">\s*<a href="(\/nbtnews\/\d+\?[^"]*)">\s*([^<]{4,200}?)<\/a>\s*<\/td>[\s\S]{0,300}?<td class="pc_Y ta_Y mo_Y nowrap">(\d{4}-\d{2}-\d{2})<\/td>/g;
function extractBusanCandidates(html, pageUrl) {
  const out = [];
  const re = new RegExp(BUSAN_ITEM_RE.source, "g");
  let m;
  while ((m = re.exec(html))) {
    const title = cleanTitle(decodeEntities(m[2]).replace(/\s+/g, " ").trim());
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

// 대구광역시청 뉴스룸 "시정소식"(mkey=2): mtnmain.php?mtnkey=articleview&mkey2=2&aid=...
// 링크, 제목은 <p class="title">, 날짜는 바로 다음 <p class="date">.
const DAEGU_ITEM_RE =
  /<a href="(\.\/mtnmain\.php\?mtnkey=articleview&mkey=scatelist&mkey2=2&aid=\d+[^"]*)"[^>]*>[\s\S]{0,400}?<p class="title">([^<]{4,200}?)<\/p>\s*<p class="date">(\d{4}-\d{2}-\d{2})<\/p>/g;
function extractDaeguCandidates(html, pageUrl) {
  const out = [];
  const re = new RegExp(DAEGU_ITEM_RE.source, "g");
  let m;
  while ((m = re.exec(html))) {
    const title = cleanTitle(decodeEntities(m[2]).replace(/\s+/g, " ").trim());
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

// 광주광역시청: /boardView.do?...boardId=BD_0000000027&seq=... 링크, 제목은 목록 텍스트가
// "..."로 잘려 있어 대신 title 속성(전체 제목)에서 추출, 날짜는 <div class="date"><span
// class="blind">작성일</span> 뒤.
const GWANGJU_ITEM_RE =
  /<a href="(\/boardView\.do\?pageId=&amp;boardId=BD_0000000027&amp;seq=\d+[^"]*)" data-view="L" data-seq="\d+" title="([^"]{4,200})"[\s\S]{0,400}?<div class="date">\s*<span class="blind">작성일<\/span>\s*(\d{4}-\d{2}-\d{2})/g;
function extractGwangjuCandidates(html, pageUrl) {
  const out = [];
  const re = new RegExp(GWANGJU_ITEM_RE.source, "g");
  let m;
  while ((m = re.exec(html))) {
    const title = cleanTitle(decodeEntities(m[2]).replace(/\s+/g, " ").trim());
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

// 대전광역시청: /drh/board/boardNormalView.do?boardId=normal_0189&... 링크, 날짜는
// <td class="date">.
const DAEJEON_ITEM_RE =
  /<td class="al_left subject"><a href="(\/drh\/board\/boardNormalView\.do\?boardId=normal_0189[^"]*)">\s*([^<]{4,200}?)\s*<\/a>[\s\S]{0,400}?<td class="date">\s*(\d{4}-\d{2}-\d{2})<\/td>/g;
function extractDaejeonCandidates(html, pageUrl) {
  const out = [];
  const re = new RegExp(DAEJEON_ITEM_RE.source, "g");
  let m;
  while ((m = re.exec(html))) {
    const title = cleanTitle(decodeEntities(m[2]).replace(/\s+/g, " ").trim());
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

const NATIONWIDE_PHASE3_BOARDS = [
  {
    org: "부산광역시청",
    sourceOrg: "부산시청 보도·해명자료",
    url: "https://www.busan.go.kr/nbtnews",
    region: "부산",
    city: "부산",
    extractor: extractBusanCandidates,
  },
  {
    org: "대구광역시청",
    sourceOrg: "대구시청 뉴스룸 시정소식",
    url: "https://info.daegu.go.kr/newshome/mtnmain.php?mtnkey=scatelist&mkey=2",
    region: "대구",
    city: "대구",
    extractor: extractDaeguCandidates,
  },
  {
    org: "광주광역시청",
    sourceOrg: "광주시청 보도자료",
    url: "https://www.gwangju.go.kr/boardList.do?boardId=BD_0000000027",
    region: "광주",
    city: "광주",
    extractor: extractGwangjuCandidates,
  },
  {
    org: "대전광역시청",
    sourceOrg: "대전시청 보도자료",
    url: "https://www.daejeon.go.kr/drh/board/boardNormalList.do?boardId=normal_0189&menuSeq=6825",
    region: "대전",
    city: "대전",
    extractor: extractDaejeonCandidates,
  },
];

// ---- 2026-10-19 전국 확대 4단계: 기관 1개뿐이던 지역(강원·충북·전남)에 기초단체를
// 하나씩 더 추가 — 실제 fetch + 정규식 매치로 직접 검증(각 8~15건) 후 등록.
//   - 부산 해운대구청/대구 구청/대전 유성구청/전북 전주시청/인천 연수구청도 조사했지만,
//     전부 실제 서버 HTML에 개별 기사 목록이 없거나(전주 index.9is, 연수 report.asp는
//     JS로 그려지는 페이지였음) 엉뚱한 과거 아카이브 게시판으로 연결돼(해운대
//     BBS_0000039는 "2019년 이전자료" 전용 게시판이었음) — 전부 SKIPPED(추측 등록
//     금지 원칙에 따라 제외). 유성구청(BBSMSTR_000000000103)은 JS 네비게이션만 있고
//     목록 자체가 서버 HTML에 없어 제외.

// 춘천시청: /mayor/newsroom/press-release/?bbsId=...&nttId=...&flag=view 링크, 제목은
// <p>, 날짜는 <ul class="news-box-info"> 안 4번째 <li>.
const CHUNCHEON_ITEM_RE =
  /<a href="(\/mayor\/newsroom\/press-release\/\?bbsId=BBSMSTR_000000000335&nttId=\d+&flag=view)"[^>]*>\s*<p>([^<]{4,200}?)<\/p>[\s\S]{0,300}?<li>(\d{4}-\d{2}-\d{2})<\/li>/g;
function extractChuncheonCandidates(html, pageUrl) {
  const out = [];
  const re = new RegExp(CHUNCHEON_ITEM_RE.source, "g");
  let m;
  while ((m = re.exec(html))) {
    const title = cleanTitle(decodeEntities(m[2]).replace(/\s+/g, " ").trim());
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

// 청주시청: ./selectBbsNttView.do?key=23485&bbsNo=40&nttNo=... 링크, 날짜는 YYYY.MM.DD
// 형식의 <td>(점 구분자라 대시로 변환).
const CHEONGJU_ITEM_RE =
  /<a href="(\.\/selectBbsNttView\.do\?key=23485&amp;bbsNo=40&amp;nttNo=\d+[^"]*)"\s*>\s*([^<]{4,200}?)\s*<[\s\S]{0,1200}?<td>(\d{4})\.(\d{2})\.(\d{2})<\/td>/g;
function extractCheongjuCandidates(html, pageUrl) {
  const out = [];
  const re = new RegExp(CHEONGJU_ITEM_RE.source, "g");
  let m;
  while ((m = re.exec(html))) {
    const title = cleanTitle(decodeEntities(m[2]).replace(/\s+/g, " ").trim());
    if (title.length < 4 || title.length > 200) continue;
    if (!NEW_SITE_KEYWORD_RE.test(title) || NOISE_RE.test(title)) continue;
    let absUrl;
    try {
      absUrl = new URL(decodeEntities(m[1]), pageUrl).href;
    } catch {
      continue;
    }
    out.push({ title, url: absUrl, postedDate: `${m[3]}-${m[4]}-${m[5]}` });
  }
  return out;
}

// 여수시청: /www/govt/news/release/press?idx=...&mode=view 링크, 제목은 title 속성("...에
// 대한 글내용 보기." 접미사를 잘라냄), 날짜가 당일 작성글은 시:분:초만 나와서(예: "11:08:50")
// 그런 행은 날짜 매치가 안 되어 자연히 건너뛴다(추측하지 않음).
const YEOSU_ITEM_RE =
  /<a href="(\/www\/govt\/news\/release\/press\?idx=\d+&amp;mode=view)" class="basic_cont[^"]*" title="([^"]{4,220}?) 에 대한 글내용 보기\."[\s\S]{0,350}?<td>(\d{4}-\d{2}-\d{2})<\/td>/g;
function extractYeosuCandidates(html, pageUrl) {
  const out = [];
  const re = new RegExp(YEOSU_ITEM_RE.source, "g");
  let m;
  while ((m = re.exec(html))) {
    const title = cleanTitle(decodeEntities(m[2]).replace(/\s+/g, " ").trim());
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

const NATIONWIDE_PHASE4_BOARDS = [
  {
    org: "강원특별자치도 춘천시청",
    sourceOrg: "춘천시청 보도자료",
    url: "https://www.chuncheon.go.kr/mayor/newsroom/press-release/",
    region: "강원",
    city: "춘천",
    extractor: extractChuncheonCandidates,
  },
  {
    org: "충청북도 청주시청",
    sourceOrg: "청주시청 보도자료",
    url: "https://www.cheongju.go.kr/www/selectBbsNttList.do?bbsNo=40&key=279",
    region: "충북",
    city: "청주",
    extractor: extractCheongjuCandidates,
  },
  {
    org: "전라남도 여수시청",
    sourceOrg: "여수시청 보도자료",
    url: "https://www.yeosu.go.kr/www/govt/news/release/press",
    region: "전남",
    city: "여수",
    extractor: extractYeosuCandidates,
  },
];

// ---- 2026-10-19 전국 확대 5단계: 울산·경남·경북 우선 보강(경남 거제·고성 추가) +
// 나머지 지역 보강(전남 함평) — 전부 실제 fetch + 정규식 매치로 검증 후 등록.
//   - 이번 단계에서 양산시청/포항시청/구미시청은 목록이 전부 JS onclick 네비게이션이라
//     서버 HTML에 상세페이지 링크가 아예 없어 제외(포항은 "portal/board/post" 계열
//     스킨 자체가 JS 전용인 것으로 보임 — 같은 스킨을 쓰는 다른 기관도 주의).
//   - 안동시청 "보도자료" 게시판은 제목이 전부 "10월 19일 보도자료"처럼 날짜만 적힌
//     묶음 공고라 실제 기사 제목이 본문/첨부에만 있어 제외(대구 공보 게시판과 동일 유형).
//   - 남해군청은 pgnews 게시판의 카테고리 필터(pCate1=9)가 2020년 글을 최상단에 반환해
//     실제 "최신 보도자료" 목록이 맞는지 확신할 수 없어 제외.
//   - 청도군청, 경상북도문화관광공사(GTC)도 조사했으나 목록이 JS 폼 제출 방식이라
//     서버 HTML에 상세페이지 링크가 없어 제외.

// 거제시청: /board/view.geoje?boardId=BBS_0000028&...dataSid=... 링크, 제목은
// <span class="tit">, 날짜는 <span class="fr">.
const GEOJE_ITEM_RE =
  /<a href="(\/board\/view\.geoje\?boardId=BBS_0000028&amp;[^"]*dataSid=\d+)">[\s\S]{0,400}?<span class="tit">([^<]{4,200}?)<\/span>[\s\S]{0,600}?<span class="fr">(\d{4}-\d{2}-\d{2})<\/span>/g;
function extractGeojeCandidates(html, pageUrl) {
  const out = [];
  const re = new RegExp(GEOJE_ITEM_RE.source, "g");
  let m;
  while ((m = re.exec(html))) {
    const title = cleanTitle(decodeEntities(m[2]).replace(/\s+/g, " ").trim());
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

// 경상남도 고성군청: /board/view.goseong?boardId=BBS_0000196&...dataSid=... 링크, 제목은
// title 속성(목록 끝에 "[부서명]" 꼬리표가 붙어 떼어냄), 날짜는 <td class="date">가
// 2자리 연도 YY.MM.DD. 형식.
const GOSEONG_GN_ITEM_RE =
  /<a href="(\/board\/view\.goseong\?boardId=BBS_0000196&amp;[^"]*dataSid=\d+)" title="([^"]{4,220}?)(?:\s*\[[^\]]*\])?">[^<]*<\/a>[\s\S]{0,500}?<td class="date">(\d{2})\.(\d{2})\.(\d{2})\.<\/td>/g;
function extractGoseongGnCandidates(html, pageUrl) {
  const out = [];
  const re = new RegExp(GOSEONG_GN_ITEM_RE.source, "g");
  let m;
  while ((m = re.exec(html))) {
    const title = cleanTitle(decodeEntities(m[2]).replace(/\s+/g, " ").trim());
    if (title.length < 4 || title.length > 200) continue;
    if (!NEW_SITE_KEYWORD_RE.test(title) || NOISE_RE.test(title)) continue;
    let absUrl;
    try {
      absUrl = new URL(decodeEntities(m[1]), pageUrl).href;
    } catch {
      continue;
    }
    out.push({ title, url: absUrl, postedDate: `20${m[3]}-${m[4]}-${m[5]}` });
  }
  return out;
}

// 전라남도 함평군청: /boardView.do?pageId=www275&boardId=NEWS&seq=... 링크(광주광역시청과
// 같은 CMS 계열이지만 스킨이 달라 목록 텍스트가 안 잘려있음), 날짜는 <div class="date">.
const HAMPYEONG_ITEM_RE =
  /<a href="(\/boardView\.do\?pageId=www275&amp;boardId=NEWS&amp;seq=\d+[^"]*)"[^>]*>\s*([^<]{4,220}?)<\/a>[\s\S]{0,300}?<div class="date">\s*<div class="blind">작성일<\/div>\s*(\d{4}-\d{2}-\d{2})/g;
function extractHampyeongCandidates(html, pageUrl) {
  const out = [];
  const re = new RegExp(HAMPYEONG_ITEM_RE.source, "g");
  let m;
  while ((m = re.exec(html))) {
    const title = cleanTitle(decodeEntities(m[2]).replace(/\s+/g, " ").trim());
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

const NATIONWIDE_PHASE5_BOARDS = [
  {
    org: "경상남도 거제시청",
    sourceOrg: "거제시청 보도자료",
    url: "https://www.geoje.go.kr/board/list.geoje?boardId=BBS_0000028&menuCd=DOM_000008902003004000",
    region: "경남",
    city: "거제",
    extractor: extractGeojeCandidates,
  },
  {
    org: "경상남도 고성군청",
    sourceOrg: "고성군청 보도자료",
    url: "https://www.goseong.go.kr/board/list.goseong?boardId=BBS_0000196&menuCd=DOM_000000102002008000",
    region: "경남",
    city: "고성",
    extractor: extractGoseongGnCandidates,
  },
  {
    org: "전라남도 함평군청",
    sourceOrg: "함평군청 보도자료",
    url: "https://www.hampyeong.go.kr/boardList.do?pageId=www275&boardId=NEWS",
    region: "전남",
    city: "함평",
    extractor: extractHampyeongCandidates,
  },
];

// ---- 2026-10-20 울산·경남·경북 6단계 보강: 시/군청이 아닌 재단·진흥원까지 확대 —
// 전부 실제 fetch + 정규식 매치로 검증 후 등록.
//   - 울산문화관광재단(uctf.or.kr)은 id="app" 등 Vue 마커가 있는 SPA라 /board/notice의
//     서버 HTML에 글 목록이 없음(네비게이션 메뉴 텍스트만 반복) — SKIPPED.
//   - 의령군청(uiryeong.go.kr)은 거제·고성과 같은 "board/list.OOO" CMS 계열로 보이지만
//     실제 요청 시 "시스템 점검 중입니다" 에러 페이지만 반환됨 — 추측 등록 금지 원칙에
//     따라 제외(사이트 자체 문제일 수 있어 추후 재확인 가치 있음).
//   - 거창군청(geochang.go.kr)은 뉴스 게시판 링크가
//     "00452.web?...&news_epct_no={{news_epct_no}}" 형태로 Vue 템플릿 placeholder가
//     그대로 노출돼 있어(서버가 값을 채우지 않음) 클라이언트 JS 렌더링으로 판단 — SKIPPED.
//   - 예천군청(ycg.kr, open.content 경로)과 봉화군청(bonghwa.go.kr, portal/board/post)은
//     둘 다 목록 페이지 서버 HTML에 개별 글 링크가 없고(예천) 검색 폼(POST)만 있어(봉화)
//     제외. 김천·영천·상주·문경·군위·의성·청송·영양·영덕·고령·성주·칠곡·울진·울릉은
//     이번 단계에서 시간 관계상 미조사 — 다음 확대 때 이어서 조사할 것.

// 경남문화예술진흥원(gcaf.or.kr): 그누보드 계열, 게시판 URL은 bo_table=sub3_1(공고/공지).
// 제목은 <a href="...bo_table=sub3_1&amp;wr_id=NNNN">TITLE</a>, 날짜는 그 뒤
// <td class="td_datetime">YYYY-MM-DD</td>.
const GCAF_ITEM_RE =
  /<a href="([^"]*bo_table=sub3_1[^"]*wr_id=\d+[^"]*)">\s*([^<]{4,200}?)\s*<\/a>[\s\S]{0,400}?<td class="td_datetime">(\d{4}-\d{2}-\d{2})<\/td>/g;
function extractGcafCandidates(html, pageUrl) {
  const out = [];
  const re = new RegExp(GCAF_ITEM_RE.source, "g");
  let m;
  while ((m = re.exec(html))) {
    const title = cleanTitle(decodeEntities(m[2]).replace(/\s+/g, " ").trim());
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

// 경남관광재단(gnto.or.kr): 공지사항(sub04/sub01_01.php)·보도자료(sub04/sub05_01.php) 둘 다
// 같은 마크업 — 제목은 <a href="...mode=view..."><span class="title">TITLE</span></a>, 날짜는
// 같은 <li> 블록 안의 <span class="date">YYYY-MM-DD</span>(제목보다 뒤에 나옴).
const GNTO_ITEM_RE =
  /<a href="([^"]*mode=view[^"]*)">[\s\S]{0,150}?<span class="title">([^<]{4,200})<\/span>[\s\S]{0,300}?<span class="date">(\d{4}-\d{2}-\d{2})<\/span>/g;
function extractGntoCandidates(html, pageUrl) {
  const out = [];
  const re = new RegExp(GNTO_ITEM_RE.source, "g");
  let m;
  while ((m = re.exec(html))) {
    const title = cleanTitle(decodeEntities(m[2]).replace(/\s+/g, " ").trim());
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

// 2026-10-22 신설: 울주문화재단(onggi.or.kr, 2026 울산옹기축제 공식 홈페이지) 축제소식
// 게시판. 상세 링크가 "/notice/<번호>?page=<N>" 형태의 REST 경로라 "parm_bod_uid=" 나
// "amode=view" 파라미터가 전혀 없음 — 범용 extractPostCandidates의 POST_LINK_RE 필터에
// 걸려 후보가 통째로 걸러지던 것을 "2026 울산옹기축제 「플리마켓」 모집 공고" 실측
// 테스트로 발견하고, 전용 추출기를 새로 만들어 해결함. 제목은 <div class="subj">, 날짜는
// 그 뒤 <span class="date ...">YYYY-MM-DD</span>.
const ONGGI_ITEM_RE =
  /<a href="(https:\/\/www\.onggi\.or\.kr\/notice\/\d+[^"]*)"[^>]*>[\s\S]{0,250}?<div class="subj">([^<]{4,150})<\/div>[\s\S]{0,450}?<span class="date[^>]*>[\s\S]{0,200}?(\d{4})-(\d{2})-(\d{2})/g;
function extractOnggiCandidates(html, pageUrl) {
  const out = [];
  const re = new RegExp(ONGGI_ITEM_RE.source, "g");
  let m;
  while ((m = re.exec(html))) {
    const title = cleanTitle(decodeEntities(m[2]).replace(/\s+/g, " ").trim());
    if (title.length < 4 || title.length > 200) continue;
    if (!NEW_SITE_KEYWORD_RE.test(title) || NOISE_RE.test(title)) continue;
    let absUrl;
    try {
      absUrl = new URL(decodeEntities(m[1]), pageUrl).href;
    } catch {
      continue;
    }
    out.push({ title, url: absUrl, postedDate: `${m[3]}-${m[4]}-${m[5]}` });
  }
  return out;
}

// 경상남도 산청군청(sancheong.go.kr) 보도자료: 충북/남양주와 같은 selectBbsNttList/View.do
// 계열이지만 스킨이 또 달라, 제목은 <strong class="news_ti">, 요약문은 <span class="news_txt">
// (창원처럼 제목에 키워드가 없고 요약문에만 있는 경우가 있어 둘을 합쳐서 판정), 날짜는
// <span class="news_date">YYYY.MM.DD</span>.
const SANCHEONG_ITEM_RE =
  /<a href="(\.\/selectBbsNttView\.do\?key=1825&amp;bbsNo=115&amp;nttNo=\d+[^"]*)"\s*>\s*<strong class="news_ti">\s*([\s\S]{0,200}?)\s*(?:<img[^>]*>)?\s*<\/strong>\s*<span class="news_txt">([\s\S]{0,800}?)<\/span>\s*<span class="news_date">(\d{4})\.(\d{2})\.(\d{2})<\/span>/g;
function extractSancheongCandidates(html, pageUrl) {
  const out = [];
  const re = new RegExp(SANCHEONG_ITEM_RE.source, "g");
  let m;
  while ((m = re.exec(html))) {
    const title = cleanTitle(decodeEntities(m[2]).replace(/\s+/g, " ").trim());
    const summary = decodeEntities(m[3]).replace(/\s+/g, " ").trim();
    if (title.length < 4 || title.length > 200) continue;
    const combined = `${title} ${summary}`;
    if (!NEW_SITE_KEYWORD_RE.test(combined) || NOISE_RE.test(title)) continue;
    let absUrl;
    try {
      absUrl = new URL(decodeEntities(m[1]), pageUrl).href;
    } catch {
      continue;
    }
    out.push({ title, url: absUrl, postedDate: `${m[4]}-${m[5]}-${m[6]}` });
  }
  return out;
}

const NATIONWIDE_PHASE6_BOARDS = [
  {
    org: "경남문화예술진흥원",
    sourceOrg: "경남문화예술진흥원 공고/공지",
    url: "https://www.gcaf.or.kr/bbs/board.php?bo_table=sub3_1",
    region: "경남",
    city: "경남",
    extractor: extractGcafCandidates,
  },
  {
    org: "경남관광재단",
    sourceOrg: "경남관광재단 공지사항",
    url: "https://www.gnto.or.kr/sub04/sub01_01.php",
    region: "경남",
    city: "경남",
    extractor: extractGntoCandidates,
  },
  {
    org: "경남관광재단",
    sourceOrg: "경남관광재단 보도자료",
    url: "https://www.gnto.or.kr/sub04/sub05_01.php",
    region: "경남",
    city: "경남",
    extractor: extractGntoCandidates,
  },
  {
    org: "경상남도 산청군청",
    sourceOrg: "산청군청 보도자료",
    url: "https://www.sancheong.go.kr/news/selectBbsNttList.do?key=1825&bbsNo=115",
    region: "경남",
    city: "산청",
    extractor: extractSancheongCandidates,
  },
];

// ---- 2026-10-20 경북 7단계 보강: 6단계에서 시간 관계상 미조사였던 경북 시·군 조사.
//   - 김천시(gc.go.kr)·영천시(yc.go.kr)·상주시(sangju.go.kr)·의성군(usc.go.kr)은
//     홈페이지 서버 응답 자체가 비정상(빈 응답/리다이렉트 루프/극히 짧은 응답)이라
//     게시판 URL 자체를 확보하지 못함 — SKIPPED(사이트 문제일 수 있어 재확인 가치 있음).
//   - 문경시(gbmg.go.kr)는 검색으로 찾은 보도자료 후보 URL들이 전부 빈 응답(0바이트)을
//     반환해 제외. 청송군(cs.go.kr)은 사이트 자체는 정상(메타 태그로 확인)이나 이번
//     조사에서 공지/보도자료 게시판의 정확한 URL을 못 찾아 미등록.
//   - 영덕군(yd.go.kr, 워드프레스)·울진군(uljin.go.kr)·고령군(goryeong.go.kr)·
//     성주군(sj.go.kr)·군위군(gunwi.go.kr)·칠곡군(chilgok.go.kr)·울릉군(ulleung.go.kr) 중
//     실제 글 목록이 서버 HTML에 있던 곳만 아래에 등록(영덕·군위·칠곡·울릉은 메뉴/목록이
//     JS·AJAX로 그려져 서버 HTML에 글 링크가 없어 제외).

// 경상북도 성주군청(sj.go.kr): 경주·영주·경산과 같은 "page.do?mnu_uid=" 계열 CMS지만, 이
// 사이트는 title 속성 없이 <td class="list_tit txtL"><a href="...bod_uid=NNNN...">제목</a>
// 구조라 OPEN_CONTENT_ITEM_RE(parm_bod_uid=+title 속성 전용)로는 안 잡힘 — 전용 추출기 필요.
// 날짜는 그 뒤 <td class="list_date">YYYY-MM-DD</td>(실제 고시공고 29건 매치 테스트 완료).
const SEONGJU_ITEM_RE =
  /<a href="(page\.do\?[^"]*bod_uid=\d+[^"]*)">([\s\S]{0,400}?)<\/a>[\s\S]{0,400}?<td class="list_date">(\d{4}-\d{2}-\d{2})<\/td>/g;
function extractSeongjuCandidates(html, pageUrl) {
  const out = [];
  const re = new RegExp(SEONGJU_ITEM_RE.source, "g");
  let m;
  while ((m = re.exec(html))) {
    const title = decodeEntities(m[2].replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
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

// 경상북도 울진군청(uljin.go.kr) 보도자료: board/list.uljin 계열(동구청과 같은 구조이나
// 스킨이 다름) — 제목은 <strong>TITLE<img .../></strong>(첨부파일 없으면 img 없음), 그 뒤
// <em class="info">작성일 : YYYY-MM-DD</em>. 실제 "N건 매칭" 테스트로 확인.
const ULJIN_ITEM_RE =
  /<a href="(\/board\/view\.uljin\?[^"]*dataSid=\d+[^"]*)">[\s\S]{0,60}?<strong>\s*([\s\S]{0,200}?)\s*(?:<img[^>]*>)?\s*<\/strong>[\s\S]{0,600}?작성일\s*:\s*(\d{4}-\d{2}-\d{2})/g;
function extractUljinCandidates(html, pageUrl) {
  const out = [];
  const re = new RegExp(ULJIN_ITEM_RE.source, "g");
  let m;
  while ((m = re.exec(html))) {
    const title = cleanTitle(decodeEntities(m[2]).replace(/\s+/g, " ").trim());
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

// 경상북도 고령군청(goryeong.go.kr) "고령뉴스"(BRD_ID=1062): 목록 항목의 상세 링크가
// <a href="javascript:;" onclick="fn_articleLink(NNNNN);">라서 겉보기엔 JS 네비게이션이지만,
// onclick 안의 글 번호가 그냥 리터럴 숫자라 정규식으로 바로 뽑을 수 있고, 그 번호로
// boardView.do?BRD_ID=1062&BOARD_IDX=NNNNN&IDX=157 상세 URL을 직접 조립하면 실제 글
// 상세페이지가 뜨는 것을 fetch로 확인했음(포항/구미처럼 글 식별자 자체가 서버 HTML에
// 없어 URL을 못 만드는 경우와 달리, 여기는 식별자가 리터럴로 노출돼 있어 조립 가능).
// 제목은 <p>TITLE</p>, 날짜는 <span class="gL_date">YYYY-MM-DD</span>.
const GORYEONG_ITEM_RE =
  /onclick="fn_articleLink\((\d+)\);"[\s\S]{0,400}?<p>([^<]{4,200})<\/p>[\s\S]{0,200}?<span class="gL_date">(\d{4}-\d{2}-\d{2})<\/span>/g;
function extractGoryeongCandidates(html, pageUrl) {
  const out = [];
  const re = new RegExp(GORYEONG_ITEM_RE.source, "g");
  let m;
  while ((m = re.exec(html))) {
    const title = cleanTitle(decodeEntities(m[2]).replace(/\s+/g, " ").trim());
    if (title.length < 4 || title.length > 200) continue;
    if (!NEW_SITE_KEYWORD_RE.test(title) || NOISE_RE.test(title)) continue;
    const absUrl = `https://www.goryeong.go.kr/kor/boardView.do?BRD_ID=1062&BOARD_IDX=${m[1]}&IDX=157`;
    out.push({ title, url: absUrl, postedDate: m[3] });
  }
  return out;
}

const NATIONWIDE_PHASE7_BOARDS = [
  {
    org: "경상북도 성주군청",
    sourceOrg: "성주군청 고시공고",
    url: "https://sj.go.kr/page.do?mnu_uid=1044",
    region: "경북",
    city: "성주",
    extractor: extractSeongjuCandidates,
  },
  {
    org: "경상북도 울진군청",
    sourceOrg: "울진군청 보도자료",
    url: "https://www.uljin.go.kr/board/list.uljin?boardId=BBS_0000126&menuCd=DOM_000000103002013000&paging=ok&startPage=1",
    region: "경북",
    city: "울진",
    extractor: extractUljinCandidates,
  },
  {
    org: "경상북도 고령군청",
    sourceOrg: "고령군청 고령뉴스",
    url: "https://www.goryeong.go.kr/kor/boardList.do?BRD_ID=1062&IDX=157",
    region: "경북",
    city: "고령",
    extractor: extractGoryeongCandidates,
  },
];

// ---- 2026-10-21 경북·경남 8단계 보강: 7단계에서 SKIPPED였던 곳을 재조사(사이트가 바뀌었을
// 수 있어서) + 아직 안 본 곳도 확인.
//   - 경북 김천시(gc.go.kr)·영천시(yc.go.kr)·상주시(sangju.go.kr) 재확인 결과:
//     * 김천시는 "통합자료실"(portal/bbs/list.do?ptIdx=1519)은 서버 렌더링되어 실제 글
//       목록을 뽑을 수 있었음(VERIFIED) — 다만 보건소 약품 소모 내역처럼 축제/부스와 무관한
//       글이 대부분이라 매칭 빈도는 낮을 것으로 예상되지만, 등록 자체는 가능해 포함.
//     * 영천시는 사이트가 new.yc.go.kr로 이전 중인 것으로 보이고(기존 yc.go.kr 메인에 메뉴
//       텍스트 자체가 없음), 이전 도메인도 접속이 불안정해 명확한 보도자료 URL을 확보하지
//       못함 — SKIPPED 유지.
//     * 상주시는 보도자료 게시판(page/10330/10640.tc)에 실제 접속은 되지만, 목록 제목이
//       전부 "보도자료(10. 20.)"처럼 날짜만 들어간 묶음형이라(안동시와 같은 문제) 제목
//       키워드 매칭이 원천적으로 불가능 — SKIPPED 유지.
//   - 경북 의성군(usc.go.kr)·청송군(cs.go.kr)·칠곡군(chilgok.go.kr)은 전부 신규 VERIFIED.
//     의성·칠곡은 title 속성 또는 onclick의 리터럴 bIdx로 상세 URL을 조립할 수 있는
//     "portal/bbs" 계열(김천과 같은 CMS, 다만 마크업 변형이 있어 전용 추출기 필요).
//   - 경북 문경(gbmg.go.kr)·영덕(yd.go.kr)·군위(gunwi.go.kr)·울릉(ulleung.go.kr)은 재확인
//     결과 메인 페이지 응답 자체가 수십~수백 바이트짜리 빈 셸이라(JS 리다이렉트 추정)
//     게시판 URL 확보 자체가 불가능 — SKIPPED 유지. 포항·안동·구미·청도·경북문화관광공사는
//     이번 단계에서 재확인하지 않음(기존 SKIPPED 사유가 바뀔 가능성이 낮아 우선순위를 낮춤).
//   - 경남 양산시(yangsan.go.kr)는 재확인 결과 목록 자체는 서버 HTML에 있으나(자료실
//     게시판), 상세보기가 전부 `onclick="yhLib.inline.post(this)"` 식 AJAX 인라인 로딩이라
//     개별 글의 실제 URL을 구성할 방법이 없음 — SKIPPED 유지(기존 조사와 동일 결론).
//   - 경남 남해군(namhae.go.kr)은 재확인 결과, 이전에 과거(2020년) 글만 보이던 건
//     카테고리 필터(pCate1) 문제가 아니라 **정렬 파라미터 누락** 때문이었음 —
//     `orderBy=wdate desc`를 붙이면 최신글이 정상적으로 나옴(실제 2026-10-20일자 글 확인).
//     기존 "카테고리 필터가 과거 글 반환"이라는 원인 진단이 부정확했던 것으로 정정하고
//     VERIFIED 등록.
//   - 경남 거창군(geochang.go.kr)은 7단계 때 "Vue 템플릿 placeholder({{news_epct_no}})
//     노출"로 제외했던 그 사이트가 재확인 결과 정상적인 리터럴 값으로 서버 렌더링되고
//     있어(사이트 쪽에서 임시 오류가 있었던 것으로 추정) VERIFIED로 재등록.
//   - 경남 창녕군(cng.go.kr)은 신규 조사 — 메인 페이지의 "창녕군 뉴스" 위젯은 제목이
//     "..."로 잘려 나와 못 쓰지만, 같은 글이 걸려 있는 전체 목록 페이지
//     (01541/01552.web?gcode=1016)는 제목이 안 잘리고 그대로 나와 이쪽을 VERIFIED 등록.
//   - 경남 의령군(uiryeong.go.kr)은 재확인해도 여전히 "의령군청 에러페이지"만 반환 —
//     SKIPPED 유지(실제 사이트 문제로 추정, 추후 재확인 가치 있음).

// 경상북도 김천시청(gc.go.kr) "통합자료실": onclick="goTo.view('list','BIDX','PTIDX','MID'...)
// 형태의 CMS — title 속성이 있을 때도/없을 때도 있어, 있으면 title을, 없으면 <a> 안쪽
// 텍스트를 쓰는 공용 추출기로 처리(칠곡군청도 같은 CMS라 재사용).
const PORTAL_BBS_ITEM_RE =
  /onclick="goTo\.view\('list','(\d+)','(\d+)','(\d+)'[^)]*\);\s*return false;"(?:\s+title="([^"]*)")?>([\s\S]{0,300}?)<\/a>[\s\S]{0,1500}?<td class="list_date">(\d{4}-\d{2}-\d{2})/g;
function makePortalBbsExtractor(viewPathTemplate) {
  return function extractPortalBbsCandidates(html, pageUrl) {
    const out = [];
    const re = new RegExp(PORTAL_BBS_ITEM_RE.source, "g");
    let m;
    while ((m = re.exec(html))) {
      let title = m[4]
        ? m[4].replace(/\s*게시글\s*바로가기$/, "")
        : m[5].replace(/<[^>]*>/g, "");
      title = decodeEntities(title).replace(/\s+/g, " ").trim();
      if (title.length < 4 || title.length > 200) continue;
      if (!NEW_SITE_KEYWORD_RE.test(title) || NOISE_RE.test(title)) continue;
      const [, bIdx, ptIdx, mId] = m;
      let absUrl;
      try {
        absUrl = new URL(viewPathTemplate(bIdx, ptIdx, mId), pageUrl).href;
      } catch {
        continue;
      }
      out.push({ title, url: absUrl, postedDate: m[6] });
    }
    return out;
  };
}
const extractGimcheonCandidates = makePortalBbsExtractor(
  (bIdx, ptIdx, mId) => `view.do?bIdx=${bIdx}&ptIdx=${ptIdx}&mId=${mId}`
);
const extractChilgokCandidates = makePortalBbsExtractor(
  (bIdx, ptIdx, mId) => `view.do?bIdx=${bIdx}&ptIdx=${ptIdx}&mId=${mId}`
);

// 경상북도 의성군청(usc.go.kr) 보도자료: title 속성이 href보다 **앞**에 오는 변형
// (page.do?...&bod_uid=NNN 계열) — 날짜는 <p class="date"><span>YYYY-MM-DD.
const UISEONG_ITEM_RE =
  /<a title=" ?([^"]{4,200})" href="([^"]*bod_uid=\d+[^"]*)">[\s\S]{0,500}?<p class="date"><span>\s*(\d{4}-\d{2}-\d{2})/g;
function extractUiseongCandidates(html, pageUrl) {
  const out = [];
  const re = new RegExp(UISEONG_ITEM_RE.source, "g");
  let m;
  while ((m = re.exec(html))) {
    const title = decodeEntities(m[1]).replace(/\s+/g, " ").trim();
    if (title.length < 4 || title.length > 200) continue;
    if (!NEW_SITE_KEYWORD_RE.test(title) || NOISE_RE.test(title)) continue;
    let absUrl;
    try {
      absUrl = new URL(decodeEntities(m[2]), pageUrl).href;
    } catch {
      continue;
    }
    out.push({ title, url: absUrl, postedDate: m[3] });
  }
  return out;
}

// 경상북도 청송군청(cs.go.kr) 공지사항: 제목은 <strong class="t1">, 날짜는
// <span class="t3">YYYY-MM-DD(쿼리스트링은 전부 &amp; 로 정상 인코딩됨).
const CHEONGSONG_ITEM_RE =
  /<a href="(\?gcode=\d+&amp;idx=\d+&amp;amode=view[^"]*)" class="a1">[\s\S]{0,60}?<strong class="t1">\s*([^\n<]{4,200})[\s\S]{0,900}?<span class="t3">(\d{4}-\d{2}-\d{2})/g;
function extractCheongsongCandidates(html, pageUrl) {
  const out = [];
  const re = new RegExp(CHEONGSONG_ITEM_RE.source, "g");
  let m;
  while ((m = re.exec(html))) {
    const title = cleanTitle(decodeEntities(m[2]).replace(/\s+/g, " ").trim());
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

// 경상남도 남해군청(namhae.go.kr) 보도자료: 목록 URL에 orderBy=wdate+desc를 반드시 붙여야
// 최신글이 나옴(안 붙이면 2020년 글만 나옴 — 과거 "카테고리 필터" 탓으로 오판했던 원인).
const NAMHAE_ITEM_RE =
  /<a href="([^"]*View\.do[^"]*)" class="a1">[\s\S]{0,400}?<strong class="t1">([^<]{4,200})<\/strong>[\s\S]{0,400}?<span class="t3">(\d{4}-\d{2}-\d{2})/g;
function extractNamhaeCandidates(html, pageUrl) {
  const out = [];
  const re = new RegExp(NAMHAE_ITEM_RE.source, "g");
  let m;
  while ((m = re.exec(html))) {
    const title = cleanTitle(decodeEntities(m[2]).replace(/\s+/g, " ").trim());
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

// 경상남도 거창군청(geochang.go.kr) 뉴스미디어포털: href의 news_epct_no가 리터럴 숫자로
// 정상 렌더링됨(7단계 때는 {{news_epct_no}} 플레이스홀더였던 것과 달리 이번엔 실측
// 정상값) — 날짜는 "등록일 : YYYY-MM-DD".
const GEOCHANG_ITEM_RE =
  /<a href="(\?amode=view&amp;news_epct_no=\d+&amp;)" class="a1">[\s\S]{0,60}?<strong class="t1">([\s\S]{4,200}?)<\/strong>[\s\S]{0,200}?등록일\s*:\s*(\d{4}-\d{2}-\d{2})/g;
function extractGeochangCandidates(html, pageUrl) {
  const out = [];
  const re = new RegExp(GEOCHANG_ITEM_RE.source, "g");
  let m;
  while ((m = re.exec(html))) {
    const title = cleanTitle(decodeEntities(m[2]).replace(/\s+/g, " ").trim());
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

// 경상남도 창녕군청(cng.go.kr) 창녕소식 전체목록: 메인 페이지 위젯은 제목이 "..."로
// 잘려서 못 쓰고, 01541/01552.web?gcode=1016 전체목록 페이지의 제목은 안 잘림.
// href의 두 번째 "&"는 인코딩이 안 돼 있어(&amp;idx=.../&amode=view&) 그대로 매치.
const CHANGNYEONG_ITEM_RE =
  /<a href="(\?gcode=1016&amp;idx=\d+&amode=view&)" class="a1">[\s\S]{0,750}?<strong class="t1">[\s\S]{0,150}?\n\s*([^\n<]{4,200})\n[\s\S]{0,400}?<span class="t2">[\s\S]{0,100}?(\d{4}-\d{2}-\d{2})/g;
function extractChangnyeongCandidates(html, pageUrl) {
  const out = [];
  const re = new RegExp(CHANGNYEONG_ITEM_RE.source, "g");
  let m;
  while ((m = re.exec(html))) {
    const title = cleanTitle(decodeEntities(m[2]).replace(/\s+/g, " ").trim());
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

const NATIONWIDE_PHASE8_BOARDS = [
  {
    org: "경상북도 김천시청",
    sourceOrg: "김천시청 통합자료실",
    url: "https://www.gc.go.kr/portal/bbs/list.do?ptIdx=1519&mId=1206010000",
    region: "경북",
    city: "김천",
    extractor: extractGimcheonCandidates,
  },
  {
    org: "경상북도 의성군청",
    sourceOrg: "의성군청 보도자료",
    url: "https://www.usc.go.kr/ko/page.do?mnu_uid=186",
    region: "경북",
    city: "의성",
    extractor: extractUiseongCandidates,
  },
  {
    org: "경상북도 청송군청",
    sourceOrg: "청송군청 공지사항",
    url: "https://www.cs.go.kr/news/00002679/00002687.web",
    region: "경북",
    city: "청송",
    extractor: extractCheongsongCandidates,
  },
  {
    org: "경상북도 칠곡군청",
    sourceOrg: "칠곡군청 공지사항",
    url: "https://www.chilgok.go.kr/portal/bbs/list.do?ptIdx=111&mId=0201010000",
    region: "경북",
    city: "칠곡",
    extractor: extractChilgokCandidates,
  },
  {
    org: "경상남도 남해군청",
    sourceOrg: "남해군청 보도자료",
    url: "https://www.namhae.go.kr/news/pgnews/List.do?pageCd=NW0201000000&orderBy=wdate+desc",
    region: "경남",
    city: "남해",
    extractor: extractNamhaeCandidates,
  },
  {
    org: "경상남도 거창군청",
    sourceOrg: "거창군청 뉴스미디어포털",
    url: "https://www.geochang.go.kr/00445/00452.web",
    region: "경남",
    city: "거창",
    extractor: extractGeochangCandidates,
  },
  {
    org: "경상남도 창녕군청",
    sourceOrg: "창녕군청 창녕소식",
    url: "https://www.cng.go.kr/01541/01552.web?gcode=1016",
    region: "경남",
    city: "창녕",
    extractor: extractChangnyeongCandidates,
  },
];

// ---- 네이버 카페·밴드·인스타그램 공개 플리마켓 셀러모집 조사 (2026-10-20, 전부 SKIPPED) ----
// 소규모 프리마켓/플리마켓 셀러 모집이 많이 올라오는 세 플랫폼을 "로그인 없이 fetch 가능한
// 공개 글"만 등록한다는 전제로 조사했으나, 셋 다 구조적으로 이 수집기(순수 HTTP+정규식,
// 로그인/쿠키/봇 우회 없음)로는 수집이 불가능해 전부 제외했다. 추측 등록 금지 원칙상 코드는
// 추가하지 않고 조사 결과만 기록한다.
//   - 네이버 카페("문화상점" 등 15만 회원급 플리마켓 정보 카페 포함): PC
//     cafe.naver.com/ArticleList.nhn은 로그인 여부와 무관하게 307로 새 SPA 프런트
//     (/f-e/cafes/{clubid}/menus/0)로 리다이렉트되고, 모바일 m.cafe.naver.com도
//     <meta name="robots" content="noindex, nofollow">가 박힌 빈 앱 셸(app=web-mobile)만
//     돌아옴 — 카페가 전체공개든 아니든 글 목록 자체가 서버 HTML에 없음(임의 클럽ID로 실측
//     확인, 특정 카페 문제가 아니라 네이버 카페 프런트엔드 전체가 이 구조임).
//   - 밴드(band.us): 공개 밴드 페이지(www.band.us/band/{id})도 200 OK로 응답은 오지만
//     제목만 들어간 뼈대 HTML(16KB, generic SPA 템플릿)이고 게시글 목록이 전혀 없음 —
//     게시글은 클라이언트가 별도 API로 받아와 렌더링하는 구조.
//   - 인스타그램: 비로그인 프로필 페이지(www.instagram.com/계정명/)가 og:title/description도
//     없고 게시물 링크(/p/...)도 0개인 로그인 유도 변형 페이지로 응답함 — 비로그인
//     봇/서버요청에는 사실상 콘텐츠를 안 줌.
// 세 플랫폼 다 "로그인 세션 획득·쿠키 유지·내부 API 역공학" 없이는 들어갈 수 없는 구조라
// (이 저장소 원칙상 금지된 방법들) SKIPPED 유지. 플랫폼이 공식 오픈 API를 제공하게 되거나
// 운영자가 직접 RSS/공개 API 키를 주는 경우가 생기면 그때 재검토.
//
// ---- 추가 조사 (2026-10-21): "스크래핑이 아니라 공식 API/공개 피드는 없는지" ----
// 위 결론은 "로그인 없는 단순 fetch(스크래핑)" 기준이었다. 이번엔 세 플랫폼이 공식으로
// 제공하는 API까지 확인했다 — 단, developers.naver.com·developers.band.us는 이 작업
// 환경의 WebFetch 허용 목록에 없어 실시간 문서 재확인은 못 했고, 아래는 공개적으로 널리
// 알려진 API 스펙 기준 정리다(실제 등록 전 사용자가 최신 문서로 한 번 더 확인 필요).
//   - 네이버 검색 오픈API "카페글검색"(openapi.naver.com/v1/search/cafearticle.json):
//     존재함. Client ID/Secret 발급(개발자 계정 무료 등록, 보통 즉시 승인)만 하면 되는
//     단순 REST+JSON 호출이라 이 수집기 철학(순수 HTTP, LLM 없음)에 맞음 — 로그인/쿠키가
//     수집기 실행 시점엔 전혀 필요 없음(앱 등록은 1회성, 그것도 사용자 본인이 해야 함).
//     단, 이 API는 "네이버 검색에 노출된(=완전 공개) 카페글"만 대상이라 비공개·반공개
//     카페 글은 원천적으로 빠지고, 특정 카페의 게시판을 통째로 가져오는 게 아니라
//     "프리마켓 셀러모집" 같은 키워드 검색 결과를 주는 구조라 지금의 "고정 보드 목록"
//     모델과는 다른 "키워드 검색" 코드 경로가 새로 필요함. **Client ID/Secret이 없어 실제
//     응답 스키마를 검증하지 못했으므로, 추측 등록 금지 원칙에 따라 코드는 추가하지
//     않았다** — 사용자가 developers.naver.com에서 무료 앱을 등록해 키를 주면, 그 키로
//     실제 응답을 한 번 확인한 뒤에 전용 수집 함수를 추가할 것.
//   - 밴드 Open API: 봇/파트너 연동용 OAuth2 구조라, 특정 밴드의 글(GET .../posts)을
//     가져오려면 "그 밴드에 가입된 사용자"가 로그인해 앱에 동의해야 access_token이
//     나온다 — 즉 공식 API로 바꿔도 "임의의 공개 밴드를 로그인 없이 가져오는" 길은
//     없음(사람의 1회 로그인·동의가 구조적으로 필수). SKIPPED 유지.
//   - 인스타그램 Graph API(developers.facebook.com, 2026-10-21 문서 직접 확인): 제3자의
//     공개 게시물을 검색/수집하는 공식 방법 없음. 본인이 소유한 Business/Creator
//     계정에만 쓸 수 있고, 일반(개인) 계정은 이 API로 접근 자체가 안 된다고 문서에
//     명시돼 있음("The Instagram API with Facebook Login cannot access Instagram
//     consumer accounts"). SKIPPED 유지.

// ---- 2026-10-21 8단계 보강: 광역단체만 연결돼 있던 부산·대구·광주·대전·세종의
// 하위 구청·재단으로 확대. 실제 fetch로 검증. ----
//   - 부산 해운대구청(board/list.do?boardId=BBS_0000039)은 응답은 오지만 이 특정
//     menuCd 조합이 "2019년 2월 이전 자료" 고정 아카이브 뷰를 가리켜(검색 결과에도
//     그렇게 표시됨) 최신 글이 전혀 없음(실제 글 날짜가 전부 2019년) — 최신 게시판의
//     정확한 menuCd를 못 찾아 SKIPPED. 부산문화재단·부산관광공사는 이번에 시간 관계상
//     미조사.
//   - 대전 유성구청(bbs/BBSMSTR_000000000103/list.do)은 목록 서버 HTML은 정상이나,
//     상세 링크가 `fn_search_detail(nttId)`로 숨겨진 폼을 **POST 제출**하는 구조라
//     (view.do를 GET으로 직접 열면 응답이 멈춤 — 실측 확인) 이 수집기가 지원하는
//     순수 GET fetch로는 상세 URL을 못 만든다 — SKIPPED(POST 세션 필요, 추측 등록 금지).
//   - 대구 중구·광주 동구·서구 등 나머지 구청, 각 시도 문화재단/관광재단은 이번
//     단계에서 시간 관계상 미조사 — 다음 확대 때 이어서 조사할 것.

// 광주 광산구청(gwangsan.go.kr) 보도자료(REPORT_NEW): 제목은
// <a href="/boardView.do?pageId=www3&amp;boardId=REPORT_NEW&amp;seq=NNNNN&amp;movePage=1">TITLE</a>
// (새 글은 그 앞에 <span class="new">새글</span>이 붙지만 앵커 밖이라 무관), 날짜는 그 뒤
// <td>YYYY-MM-DD</td>. 실제 "91억 원 광산사랑상품권 ‘조기 완판’"(2026-10-20) 등으로 검증.
const GWANGSAN_ITEM_RE =
  /<a href="(\/boardView\.do\?pageId=www3&amp;boardId=REPORT_NEW&amp;seq=\d+[^"]*)"[^>]*>\s*([^<]{4,200}?)\s*<\/a>[\s\S]{0,300}?<td>(\d{4}-\d{2}-\d{2})<\/td>/g;
function extractGwangsanCandidates(html, pageUrl) {
  const out = [];
  const re = new RegExp(GWANGSAN_ITEM_RE.source, "g");
  let m;
  while ((m = re.exec(html))) {
    const title = cleanTitle(decodeEntities(m[2]).replace(/\s+/g, " ").trim());
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

// 대구 수성구청(suseong.kr) 공지사항: 목록 행의 상세 링크가
// onclick="fn_icms_navi_common('view', 'NNNNNN');return false;"라서 겉보기엔 JS
// 네비게이션이지만, 안의 글 번호(nttId)가 리터럴 숫자라 고령군청과 같은 방식으로
// index.do?menu_id=00000063&menu_link=/icms/bbs/selectBoardArticle.do&bbsId=
// BBSMSTR_000000000015&nttId=NNNNNN 상세 URL을 직접 조립할 수 있음(실제 글
// "공동주택 전기자동차 충전시설 설치 현황 자료 제출"로 조립된 URL이 그대로 열리는 것을
// fetch로 확인). 날짜는 그 뒤 <td>YYYY-MM-DD</td>.
const SUSEONG_ITEM_RE =
  /fn_icms_navi_common\('view',\s*'(\d+)'\);return false;">([^<]{4,200})<\/a>[\s\S]{0,250}?<td>(\d{4}-\d{2}-\d{2})<\/td>/g;
function extractSuseongCandidates(html, _pageUrl) {
  const out = [];
  const re = new RegExp(SUSEONG_ITEM_RE.source, "g");
  let m;
  while ((m = re.exec(html))) {
    const title = cleanTitle(decodeEntities(m[2]).replace(/\s+/g, " ").trim());
    if (title.length < 4 || title.length > 200) continue;
    if (!NEW_SITE_KEYWORD_RE.test(title) || NOISE_RE.test(title)) continue;
    const absUrl = `https://www.suseong.kr/index.do?menu_id=00000063&menu_link=/icms/bbs/selectBoardArticle.do&bbsId=BBSMSTR_000000000015&nttId=${m[1]}`;
    out.push({ title, url: absUrl, postedDate: m[3] });
  }
  return out;
}

const NATIONWIDE_PHASE9_BOARDS = [
  {
    org: "광주광역시 광산구청",
    sourceOrg: "광산구청 보도자료",
    url: "https://www.gwangsan.go.kr/boardList.do?pageId=www3&boardId=REPORT_NEW&movePage=1",
    region: "광주",
    city: "광산",
    extractor: extractGwangsanCandidates,
  },
  {
    org: "대구광역시 수성구청",
    sourceOrg: "수성구청 공지사항",
    url: "https://www.suseong.kr/index.do?menu_id=00000063",
    region: "대구",
    city: "수성",
    extractor: extractSuseongCandidates,
  },
  // 2026-10-22 신설: 울주문화재단(2026 울산옹기축제 공식 홈페이지) — "2026 울산옹기축제
  // 「플리마켓」 모집 공고" 실측 테스트로 발견·등록. 전용 추출기 필요(위 ONGGI_ITEM_RE 설명 참고).
  {
    org: "울주문화재단",
    sourceOrg: "울주문화재단 축제소식(울산옹기축제)",
    url: "https://www.onggi.or.kr/notice",
    region: "울산",
    city: "울주",
    extractor: extractOnggiCandidates,
  },
];

// ---- 2026-10-21 10단계 보강: 광역단체 1곳만 연결돼 있던 인천·전북·제주·충남의 하위
// 시·군·구 조사. 이번엔 충남 공주시청 1곳만 실제로 서버 HTML에서 글 목록+날짜를 뽑아낼
// 수 있었음을 확인해 등록. 나머지는 전부 조사해봤지만 구조적으로 안 돼서 SKIPPED:
//   - 인천 중구청(icjg.go.kr)은 2026-07-01부로 제물포구·영종구로 분리·폐지돼 더 이상
//     존재하지 않는 기관임(검색으로 확인) — 등록 대상 자체가 아님.
//   - 인천 서구(최근 "서해구"로 개칭, seohae.go.kr)·강화군(ganghwa.go.kr)은 둘 다
//     bbsMsgList.do?bcd=report 게시판이 200 OK로 열리고 anchor도 많지만, pgno
//     파라미터가 일반적인 "몇 페이지째"가 아니라 전체 글 수 기준 절대 인덱스라
//     최신글이 있는 올바른 pgno 값을 알아낼 방법이 없었고(기본 호출은 항상 "오늘 올라온
//     글"만 보여줘 키워드 매치 테스트 자체가 불가능), keyword= 검색 파라미터도 결과가
//     0건이라 실제 축제/장터 글이 있는지 확인할 수 없어 보류.
//   - 익산시청(iksan.go.kr/m.iksan.go.kr)의 board/list.iksan 엔드포인트는 검색으로 찾은
//     모든 파라미터 조합이 404/502 — 정확한 엔드포인트를 못 찾음.
//   - 천안시청(cheonan.go.kr)도 cop/bbs/selectBoardList.do가 404 — 동구청과 같은 CMS로
//     보이나 정확한 엔드포인트 미확보.
//   - 전주시청(jeonju.go.kr, "index.9is" 자체 CMS)·제주시청(jejusi.go.kr)은 이번 조사
//     시간 안에 보도자료/공지사항 게시판의 정확한 목록 URL 자체를 못 찾음.
// 전북·제주·인천·천안/익산은 전부 "미완료" — 다음 단계에서 이어서 조사할 것.

// 충남 공주시청(gongju.go.kr) 보도자료: 상세 링크가
// <a href="#view" onclick="javascript: fn_search_detail('ID'); return false;">제목</a>
// 형태라 겉보기엔 JS 네비게이션이지만(폼 POST로 이동), ID 자체가 리터럴 문자열로 서버
// HTML에 노출돼 있어 고령군청과 같은 방식으로 상세 URL(view.do?nttId=ID)을 직접 조립해
// 등록 가능. 날짜는 그 뒤 <td class="regDate">YYYY-MM-DD</td> 계열로, 제목 뒤
// 3000자 이내에 등장함(실측). 실제 5·8페이지에서 "바로마켓 백제금강점 하반기 장터
// 9월 5일 개장", "제2회 공주야(夜)밤 맥주축제 성공 개최 총력" 등 실제 글 매치 확인.
const GONGJU_ITEM_RE =
  /fn_search_detail\('([^']+)'\);\s*return false;"\s*>\s*([\s\S]{4,200}?)<\/a>[\s\S]{0,3000}?(\d{4})-(\d{2})-(\d{2})/g;
function extractGongjuCandidates(html, pageUrl) {
  const out = [];
  const re = new RegExp(GONGJU_ITEM_RE.source, "g");
  let m;
  while ((m = re.exec(html))) {
    const title = cleanTitle(decodeEntities(m[2]).replace(/\s+/g, " ").trim());
    if (title.length < 4 || title.length > 200) continue;
    if (!NEW_SITE_KEYWORD_RE.test(title) || NOISE_RE.test(title)) continue;
    const absUrl = `https://www.gongju.go.kr/prog/saeolNews/sub04_02_01/view.do?nttId=${encodeURIComponent(m[1])}`;
    out.push({ title, url: absUrl, postedDate: `${m[3]}-${m[4]}-${m[5]}` });
  }
  return out;
}

const NATIONWIDE_PHASE10_BOARDS = [1, 2, 3, 5, 8, 12, 16, 20].map((p) => ({
  org: "충청남도 공주시청",
  sourceOrg: "공주시청 보도자료",
  url: `https://www.gongju.go.kr/prog/saeolNews/sub04_02_01/list.do?pageIndex=${p}`,
  region: "충남",
  city: "공주",
  extractor: extractGongjuCandidates,
}));

const NATIONWIDE_PHASE1_BOARDS = [
  {
    org: "강원특별자치도청",
    sourceOrg: "강원도청 보도자료",
    url: "https://state.gwd.go.kr/portal/briefing/pressRelease",
    region: "강원",
    city: "강원",
    extractor: extractGangwonCandidates,
  },
  {
    org: "충청북도청",
    sourceOrg: "충청북도청 보도자료",
    url: "https://www.chungbuk.go.kr/www/selectBbsNttList.do?key=429&bbsNo=65",
    region: "충북",
    city: "충북",
    extractor: extractChungbukCandidates,
  },
  {
    org: "제주특별자치도 서귀포시청",
    sourceOrg: "서귀포시청 시정뉴스",
    url: "https://www.seogwipo.go.kr/news/seogwiponews/sijungnews.htm",
    region: "제주",
    city: "서귀포",
    extractor: extractSeogwipoCandidates,
  },
  {
    org: "인천광역시청",
    sourceOrg: "인천시청 보도자료",
    url: "https://www.incheon.go.kr/IC010205/list",
    region: "인천",
    city: "인천",
    extractor: extractIncheonCandidates,
  },
];

// 2026-10-22 신설: 목록 배너/위젯 링크의 보이는 텍스트 끝에 "자세히보기" 같은 버튼
// 문구가 실제 제목과 함께 그대로 붙어 캡처되는 경우(김해 진영단감축제 메인 "알림판"
// 배너 사례로 실측 확인)가 있어, 흔한 CTA 꼬리말만 제목 끝에서 제거한다 — 내용 자체는
// 바꾸지 않고 UI 버튼 텍스트만 떼어낸다(여러 번 붙어 있어도 전부 제거).
const TITLE_TRAILING_CTA_RE = /\s*(자세히\s*보기|더\s*보기|바로\s*가기|보러\s*가기)\s*$/;
function cleanTitle(text) {
  let t = text;
  let prev;
  do {
    prev = t;
    t = t.replace(TITLE_TRAILING_CTA_RE, "").trim();
  } while (t !== prev);
  return t;
}

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
    text = cleanTitle(text);
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

// 모집 관련 제목 여부 — KEYWORD_RE보다 좁게, "모집" 계열 공고만 1차 후보로 봄.
// 2026-10-22 보강: "부스 참가 신청"처럼 "모집"이라는 글자 없이 "참가 신청"으로만
// 표현하는 경우도 모집 의도로 본다(요청사항 — 자동수집 키워드 개선).
const RECRUIT_TITLE_RE = /(모집|신청자\s*모집|참여자\s*모집|참가업체\s*모집|셀러\s*모집|참가\s*신청)/;
// 실제 판매부스·체험부스·프리마켓·푸드트럭·셀러 등 "부스/상인" 모집인지 — 교육프로그램
// 참가자 모집, 자원봉사 모집, 공연팀/버스킹 모집처럼 부스와 무관한 모집과 구분하기 위한
// 좁은 키워드(2026-10-16 추가: 분류 정확도 개선 요청에 따라 신설).
// 2026-10-22 보강: "부스 운영업체 모집"/"입점업체 모집"/"참여업체 모집"처럼 "업체"가
// 중간에 끼는 표현(요청사항 — 자동수집 키워드 개선)을 놓치고 있던 것을 보강. 기존
// "부스 운영자"/"입점 모집"만으로는 "운영업체"/"입점업체"를 못 잡았음(실측 확인).
// 2026-10-23 보강: 울산쇠부리축제(북구) 실측 — "먹거리장터 운영단체 모집 공고"처럼
// "부스"라는 글자 없이 "먹거리장터"만 쓰는 표현을 놓치고 있었음(기존엔 "먹거리\s*부스"만
// 잡았음). 푸드트럭/먹거리 부스와 같은 의미로 쓰이는 실제 표현이라 추가함.
const BOOTH_KEYWORD_RE =
  /(판매\s*부스|체험\s*부스|먹거리\s*부스|식음료\s*부스|먹거리\s*장터|프리마켓|플리마켓|푸드트럭|나눔장터|주말장터|벼룩시장|셀러\s*모집|셀러모집|부스\s*모집|부스\s*참가|부스\s*운영(?:자|업체)|입점\s*(?:모집|업체)|판매자\s*모집|참여상인\s*모집|참가업체\s*모집|참여업체\s*모집)/;
// 이미 끝난 모집/행사(결과·선정·완료·개최 종료) — 제목만으로 general 처리.
// "성료"가 빠져 있어 "OO축제 성료" 같은 종료 소식이 그대로 섞여 들어오던 문제를
// 2026-10-16에 실제 수집 결과에서 확인하고 추가함(밀양시청 테스트 중 발견).
// 2026-10-23 보강: 울산쇠부리축제 실측 — "먹거리장터 운영단체 모집 결과 공고"처럼
// "선정 결과"가 아니라 "모집 결과"라고만 쓰는 경우도 있어 추가(바로 위 BOOTH_KEYWORD_RE에
// "먹거리장터"를 추가하면서, 이미 끝난 "모집 결과" 공고까지 recruit로 잘못 분류되지
// 않게 짝을 맞춤).
const RESULT_TITLE_RE = /(선정\s*결과|모집\s*결과|결과\s*안내|마감되었|종료되었|성황리|성료|마무리)/;
// 본문에서 모집/접수/신청 기간 날짜 범위 추출 (2026-10-17: 날짜 표현 다양화 — 실제
// 수집 데이터에서 "모집기간: YYYY.M.D~YYYY.M.D" 형태 하나만 잡던 기존 정규식이
// "신청마감 YYYY-MM-DD"(마감일만 언급), "O월 O일부터 O월 O일까지"(연도 없는 한글 표현)
// 같은 흔한 표현을 놓쳐서 사람이 직접 원문을 확인해야 했던 사례가 여러 번 있었음.
// 구분자에 "/"도 허용하고, 아래 두 패턴을 추가로 둔다 — 단, 시작일을 확정 못 하는
// 경우(마감일만 언급)는 "마감(closed)" 판정에만 쓰고 "모집중(open)"이라고 단정하지
// 않는다(추측 금지 원칙 유지, extractDateRange() 참고).
// 2026-10-22 수정: "2026. 10. 14.(수) 11:00 ~ 2026. 10. 21.(수) 18:00"처럼 날짜 뒤에
// "(요일) HH:MM"이 붙어 "~" 앞까지 바로 이어지지 않는 경우(영주시 자원재활용 한마당
// 참가자 모집 실측 사례)를 잡기 위해, 날짜와 "~" 사이에 끼는 요일·시간을 선택적으로
// 허용한다. 끝 날짜 뒤에도 같은 꼬리가 붙을 수 있어 동일하게 허용.
const DATE_TAIL_RE_SRC = "\\.?\\s*(?:\\([^)]{1,4}\\))?\\s*(?:\\d{1,2}:\\d{2})?";
// 2026-10-22 수정: "○ (모집기간) 2026. 10. 21.(수) ~ ..." 처럼 라벨을 괄호로 감싸고
// 콜론 없이 바로 값이 오는 정부 공문 양식(세종시 반곡동 플리마켓 모집 실측 사례)을
// 못 잡던 문제 — 라벨 뒤 ")"를 선택적으로 허용한다.
const DATE_RANGE_RE = new RegExp(
  "(?:모집|접수|신청)\\s*(?:기간|기한)?\\s*\\)?\\s*[:：]?\\s*(\\d{4}[.\\-/]\\s?\\d{1,2}[.\\-/]\\s?\\d{1,2})" +
    DATE_TAIL_RE_SRC +
    "\\s*(?:~|-|부터)\\s*(\\d{4}[.\\-/]\\s?\\d{1,2}[.\\-/]\\s?\\d{1,2})" +
    DATE_TAIL_RE_SRC
);
// 연도 없이 "O월 O일부터 O월 O일까지"만 적힌 경우 — 수집 시점(올해)을 연도로 가정
const KOREAN_MONTH_DAY_RANGE_RE =
  /(\d{1,2})\s*월\s*(\d{1,2})\s*일\s*(?:\([^)]{1,4}\))?\s*(?:~|-|부터)\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/;
// 2026-10-22 신설: "공고·접수: 2. 20.(금) ~ 3. 13.(금)"처럼 "월"/"일" 글자 없이 점(.)
// 으로만 구분하고 연도도 없는 표기 — HWP 공문에서 자주 쓰는 축약형(2026 울산옹기축제
// 플리마켓 모집 공고 .hwp 첨부파일 실측 확인). "월"/"일" 글자가 없어 숫자 범위만으로는
// 오탐 위험이 있으므로(전화번호·가격 등과 혼동), KOREAN_MONTH_DAY_RANGE_RE와 달리
// "모집/접수/신청/공고" 라벨이 바로 앞에 있을 때만 인정한다.
const NUMERIC_MONTH_DAY_RANGE_RE =
  /(?:모집|접수|신청|공고)(?:\s*[·∙]\s*(?:모집|접수|신청|공고))?\s*(?:기간|기한)?\s*\)?\s*[:：]?\s*(\d{1,2})\s*\.\s*(\d{1,2})\s*\.?\s*(?:\([^)]{1,4}\))?\s*(?:~|-|부터)\s*(\d{1,2})\s*\.\s*(\d{1,2})\s*\.?\s*(?:\([^)]{1,4}\))?/;
// 마감일만 언급된 경우(시작일 없음). 2026-10-22 수정: "모집기간 : 2026. 8. 30.(일) 까지"
// 처럼 날짜와 "까지" 사이에 요일 괄호가 끼는 표현(덕신온마켓 셀러모집 실측 사례)을
// 날짜 끝의 "."과 "(요일)"을 선택적으로 허용해 잡는다.
const DATE_DEADLINE_ONLY_RE =
  /(?:신청|접수|모집)\s*(?:기간|기한)?\s*\)?\s*(?:마감|종료)\s*[:：]?\s*(\d{4}[.\-/]\s?\d{1,2}[.\-/]\s?\d{1,2})|(\d{4}[.\-/]\s?\d{1,2}[.\-/]\s?\d{1,2})\.?\s*(?:\([^)]{1,4}\))?\s*까지/;
// 2026-10-22 신설: "모집기간 : ~5월 31일까지"처럼 연도 없이 한글 월/일로만 마감일을
// 적은 경우(울주군 덕신온마켓 셀러모집 실측 사례) — KOREAN_MONTH_DAY_RANGE_RE와 같은
// 전제(연도 없으면 수집 시점의 연도로 가정)로 마감일만 뽑는다.
const KOREAN_MONTH_DAY_DEADLINE_RE =
  /(?:신청|접수|모집)\s*(?:기간|기한)?\s*\)?\s*[:：]?\s*~?\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일\s*까지/;
const ATTACHMENT_RE = /([^\s]+\.(?:hwp|hwpx|pdf|jpg|jpeg|png))\s*다운로드/gi;

// ---- 2026-10-21 신설: 모집공고 상세정보(행사명/장소/기간/모집규모/참가비/신청방법) 자동
// 추출. 정부 공고 양식은 라벨(행사명/기간/장소 등)이 2~3글자라 "행 사 명"처럼 글자마다
// 벌려 쓴 PDF 레이아웃이 실측으로 확인돼(경주 윈터포차라이트 PDF), 라벨 내부에 \s*를
// 끼워 넣어 공백이 있어도/없어도 매치되게 한다. 값은 줄바꿈 전까지만 캡처해 다음 라벨과
// 섞이지 않게 한다. 매치 안 되면 null -> 화면에서 "확인 필요"로 표시(추측 금지 원칙).
// 2026-10-22 수정: "○ (행 사 명) ..." 처럼 라벨을 괄호로 감싸고 콜론 없이 값이 오는
// 양식(세종시 반곡동 플리마켓 모집 실측 사례)도 잡도록, 구분자로 콜론 또는 라벨 뒤
// ")" 중 하나를 허용한다(둘 다 없으면 매치 안 함 — 추측 방지, 구분자 자체는 필수).
const EVENT_NAME_RE = /행\s*사\s*명\s*(?:[:：]|\))\s*([^\n]{2,80})/;
const VENUE_RE = /(?:행\s*사\s*장\s*소|개\s*최\s*장\s*소|장\s*소)\s*(?:[:：]|\))\s*([^\n]{2,60})/;
const BOOTH_COUNT_RE = /(?:모\s*집\s*규\s*모|부스\s*수|참가\s*업체\s*수)\s*(?:[:：]|\))\s*([^\n]{1,40})/;
// 2026-10-22 보강: "입점비: 없음"(참가비 대신 쓰는 표현, 2026 울산옹기축제 플리마켓
// 모집 공고 .hwp 첨부파일 실측 확인)도 참가비 라벨로 인정.
const FEE_RE = /(?:참\s*가\s*비|입\s*점\s*비)\s*(?:[:：]|\))\s*([^\n]{1,40})/;
const APPLY_METHOD_RE = /(?:접수\s*방법|신청\s*방법|제출\s*방법)\s*(?:[:：]|\))\s*([^\n]{1,60})/;
// 2026-10-22 신설: 본문에 "신청링크/접수링크/신청서 작성/바로가기" 같은 라벨과 함께 별도
// 신청 페이지(구글폼·네이버폼 등) URL이 적혀 있는 경우만 뽑는다 — 이메일 접수처럼 URL이
// 아예 없는 경우는 매치되지 않아 null로 남고, 호출 쪽에서 원문 공고 링크로 대체한다.
// 라벨과 URL 사이에 "(구글폼 작성 후 제출)"처럼 부가설명과 "→" 화살표가 끼는 경우가
// 실제로 많아(울주군 덕신온마켓 셀러모집 실측 사례), 괄호 설명과 화살표/콜론을 전부
// 선택적으로 허용한다.
const APPLY_LINK_RE =
  /(?:신청\s*링크|접수\s*링크|신청서?\s*(?:작성|바로가기|링크)|구글\s*폼|신청\s*페이지)\s*(?:\([^)]{0,40}\))?\s*(?:[:：]|→|->)?\s*(https?:\/\/[^\s<>"'\n]+)/i;

// "라벨: YYYY.M.D ~ (YYYY.)(M.)D" 형태를 라벨 종류 무관하게 전부 찾아서, 라벨 텍스트로
// "모집/접수/신청 기간"(기존 extractDateRange가 이미 처리)과 "행사 기간"을 구분한다.
// 레이블 앞에서 글자 단위로 안 벌어지는 경우/벌어지는 경우 둘 다 매치하려고 라벨 자체는
// 넓게(1~4글자, 글자 사이 공백 허용) 잡고 JS 코드에서 내용으로 판정 — 정규식 lookbehind로
// "모집/접수/신청"을 제외하려던 첫 시도보다 훨씬 안전함(실제 "기간"만 단독으로 쓰인 라벨도
// 있어 lookbehind 방식은 오탐 위험이 있었음, 로컬 테스트로 확인하고 이 방식으로 교체).
// 2026-10-22 수정: "○ (일시) 2026. 10. 31.(토) 16:00~20:00"처럼 라벨을 괄호로 감싸고
// 콜론 없이 바로 날짜가 오는 양식(세종시 반곡동 플리마켓 모집 실측 사례)도 잡도록,
// 구분자로 콜론 또는 라벨 뒤 ")" 중 하나를 허용한다.
const LABELED_DATE_RANGE_RE =
  /([가-힣](?:\s*[가-힣]){0,3})\s*(?:[:：]|\))\s*(\d{4})[.\-/]\s*(\d{1,2})[.\-/]\s*(\d{1,2})\.?\s*(?:\([^)]{0,4}\))?\s*(?:~|-|부터)\s*(?:(\d{4})[.\-/]\s*)?(?:(\d{1,2})[.\-/]\s*)?(\d{1,2})\.?\s*(?:\([^)]{0,4}\))?/g;
// 마감일을 "공고일 ~ M.D" 형태(연도 없이, 시작일은 "공고일"이라는 말로만 표현)로 쓰는
// 경우가 실제로 많음(경주 사례로 확인) — 이 경우 공고가 이미 게시됐다는 사실 자체가
// "시작됨"의 증거이므로, 기존 "마감일만 있는 경우"(unknown 유지)보다 한 단계 더 확실하게
// open/closed를 판정할 수 있다.
const APPLY_PERIOD_ANNOUNCE_RE =
  /(?:접수|신청|모집)\s*(?:기간|기한)?\s*\)?\s*[:：]?\s*공고일\s*(?:~|-|부터)\s*(?:(\d{4})[.\-/]\s*)?(\d{1,2})[.\-/]\s*(\d{1,2})\.?\s*(?:\([^)]{0,4}\))?/;
// "OO시/군/구에 사업장을 둔(두고)" 식으로 특정 지자체를 참가 전제조건으로 못박는 표현은
// "만"/"한정" 같은 명시적 단어가 없어도 사실상 관내 한정이다(경주 사례로 실측 확인 —
// 기존 ELIGIBILITY_OUTSIDE_NO_RE는 "만/한정" 트레일링을 요구해 이 표현을 놓쳤음).
// 2026-10-22 추가(둘째·셋째 대안): "OO시 거주자 및 사업자"/"OO 지역 거주자"처럼
// "~에 사업장을 둔" 표현이 아니라 "거주(자)"로만 지역을 못박는 경우도 실제로 흔함
// (울주군 덕신온마켓 셀러모집 실측 사례 2건: "울산광역시 거주자 및 사업자",
// "울산 지역 거주자 및 사업자") — 셋 중 region은 group 1/2/3 중 하나에 잡히므로
// 호출부에서 전부 확인한다. 첫째 대안은 "사업장"뿐 아니라 "사업자"를 둔(영주시
// 자원재활용 한마당 "프리마켓존" 모집 실측 사례: "영주시에 사업자를 둔 친환경
// 공방")도 같은 뜻이라 함께 허용한다.
// 2026-10-22 추가: "세종시 관내 거주 성인 누구나"처럼 지역명과 "거주" 사이에 "관내"가
// 끼는 표현(세종시 반곡동 플리마켓 모집 실측 사례)도 관내 한정으로 인식한다.
// 2026-10-22 추가(넷째 대안): "울산광역시에 판매 대상 품목의 사업자등록이 된 셀러"처럼
// "~시/군/구에 ...사업자등록이 된"으로 표현하는 경우(2026 울산옹기축제 플리마켓 모집
// 공고 .hwp 첨부파일 실측 확인) — "사업장을 둔"과는 다른 phrasing이라 기존 첫째
// 대안이 못 잡았음.
const ELIGIBILITY_LOCAL_BIZ_RE =
  /([가-힣]{2,6}(?:시|군|구))에\s*사업(?:장|자)[을를]\s*(?:둔|두고|두거나)|([가-힣]{2,6}(?:특별시|광역시|시|군|구))\s*(?:관내\s*)?거주(?:자|하는)?\s*(?:및\s*사업자)?|([가-힣]{2,6})\s*지역\s*거주(?:자|하는)?|([가-힣]{2,6}(?:특별시|광역시|시|군|구))에\s*[^.\n]{0,20}?사업자\s*등록이?\s*된/;

function cleanValue(s) {
  return s ? s.replace(/\s+/g, " ").trim() : null;
}

function extractVenue(text) {
  const m = text.match(VENUE_RE);
  return m ? cleanValue(m[1]) : null;
}

// 2026-10-24 신설: "출처(city, 어느 구청·군청 게시판에서 수집했는지)"와 "실제 행사
// 개최지(eventCity)"는 다를 수 있다(예: 울주문화재단이 올린 글이라도 행사 자체는
// 다른 지역일 가능성) — 둘을 구분해 기록하기 위한 최소 추출. 장소(venue) 텍스트에
// 울산 5개 구·군 이름이 "명시적으로" 들어있을 때만 값을 채우고, 없으면 추측하지
// 않고 null로 남긴다(예: "강동몽돌해변"처럼 구·군 이름 없이 지명만 있는 경우는
// 못 잡아도 안전하게 null — 지역 매핑 사전을 만들어 추측하지 않는다는 원칙 유지).
const ULSAN_DISTRICT_RE = /(북구|중구|동구|남구|울주군?)/;
function extractEventCity(venueText) {
  if (!venueText) return null;
  const m = venueText.match(ULSAN_DISTRICT_RE);
  return m ? m[1].replace(/^울주군$/, "울주") : null;
}
function extractBoothCount(text) {
  const m = text.match(BOOTH_COUNT_RE);
  return m ? cleanValue(m[1]) : null;
}
function extractFee(text) {
  const m = text.match(FEE_RE);
  return m ? cleanValue(m[1]) : null;
}
function extractApplyMethod(text) {
  const m = text.match(APPLY_METHOD_RE);
  return m ? cleanValue(m[1]) : null;
}
function extractApplyLink(text) {
  const m = text.match(APPLY_LINK_RE);
  if (!m) return null;
  try {
    return new URL(m[1]).href;
  } catch {
    return null;
  }
}
function extractEventName(text) {
  const m = text.match(EVENT_NAME_RE);
  return m ? cleanValue(m[1]) : null;
}

// 행사(개최) 기간 — 모집기간과는 다른 필드(festivalStart/festivalEnd). "모집/접수/신청"
// 라벨은 제외하고, 그 외 날짜범위 라벨(기간/행사기간/행사일/축제기간/개최기간 등)
// 중 처음 나오는 것을 행사 기간으로 본다. 둘 다 없으면 null -> 확인 필요.
// 2026-10-22 신설: 범위("~")가 아니라 "일시 : 2026.6.13.(토) 12:00~20:00"처럼 하루짜리
// 행사 날짜만 적힌 경우(덕신온마켓 셀러모집 실측 사례 — 행사는 6/13 하루뿐이고 그
// 뒤의 "12:00~20:00"은 시간 범위일 뿐 날짜 범위가 아님) festivalStart/End를 모두
// 이 날짜로 본다. 오탐을 줄이기 위해 "모집/접수/신청"과는 무관한, 행사 날짜를
// 가리키는 라벨로만 한정한다.
const EVENT_SINGLE_DATE_RE =
  /(?:행사\s*일시|행사\s*일자|개최\s*일시|개최\s*일자|축제\s*일시|일\s*시)\s*(?:[:：]|\))\s*(\d{4})[.\-/]\s*(\d{1,2})[.\-/]\s*(\d{1,2})/;
function extractEventPeriod(text) {
  const re = new RegExp(LABELED_DATE_RANGE_RE.source, "g");
  let m;
  while ((m = re.exec(text))) {
    const label = m[1].replace(/\s+/g, "");
    if (/모집|접수|신청/.test(label)) continue;
    const [, , y, mo, d, ey, emo, ed] = m;
    const endYear = ey || y;
    const endMonth = emo || mo;
    return {
      festivalStart: `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`,
      festivalEnd: `${endYear}-${endMonth.padStart(2, "0")}-${ed.padStart(2, "0")}`,
    };
  }
  const single = text.match(EVENT_SINGLE_DATE_RE);
  if (single) {
    const d = `${single[1]}-${String(single[2]).padStart(2, "0")}-${String(single[3]).padStart(2, "0")}`;
    return { festivalStart: d, festivalEnd: d };
  }
  return { festivalStart: null, festivalEnd: null };
}

// 제공시설(부스 크기·전기·테이블 등)은 사이트마다 표현이 너무 다양해 필드별로 쪼개지
// 않고, "지원 사항"/"제공 사항" 블록의 불릿 목록을 하나의 설명 문자열로 그대로 옮긴다
// (추측 조합 없음 — 원문 불릿을 그대로 보여줘서 사람이 바로 판단할 수 있게 함).
function extractFacilities(text) {
  const m = text.match(
    /(?:지원\s*사항|제공\s*사항|지원\s*내용)\s*\n([\s\S]{1,600}?)(?=\n□|\n선정\s*방법|\n접수|\n문의처|$)/
  );
  if (!m) return null;
  const lines = m[1]
    .split("\n")
    .map((l) => cleanValue(l.replace(/^[-◦\s]+/, "")))
    .filter((l) => l && l.length > 0 && l.length < 120);
  if (!lines.length) return null;
  return lines.slice(0, 8).join("; ");
}

// 관외(타지역) 사업자 참가 가능 여부 (2026-10-17 신설) — 반드시 본문에 명시적 근거
// 문구가 있을 때만 yes/no로 판정하고, 그 외에는 전부 "unknown"으로 남긴다. 둘 다
// 매치되거나(모순) 둘 다 안 매치되면(근거 없음) 애매한 것으로 보고 unknown 유지.
const ELIGIBILITY_OUTSIDE_OK_RE =
  /(관외.{0,12}(가능|무관|상관없|제한\s*없)|관내외\s*(무관|구분\s*없)|지역\s*제한\s*없|전국\s*(누구나|대상|모집)|거주지\s*무관|개인\s*또는\s*단체\s*누구나|지역\s*무관)/;
// 둘째 그룹(마지막 대안)은 "안동시에 주소를 둔 ...만" 처럼 "관내"라는 단어 없이
// 특정 시·군·구 이름으로 관내 한정을 표현하는, 실제 수집 데이터에서 자주 보이는
// 패턴까지 잡기 위한 것(2026-10-17 보강).
const ELIGIBILITY_OUTSIDE_NO_RE =
  /(관내\s*(거주|소재|주소|업체|사업자|한정)[^.]{0,10}(만|한정)|관외\s*(불가|제외|배제)|지역\s*내\s*(업체|사업자|거주자)만|해당\s*지역\s*거주자?\s*만|[가-힣]{2,6}(시|군|구)에\s*(주소를\s*둔|소재한|거주하는)[^.]{0,20}(만|한정))/;

// 부스 종류 라벨 — BOOTH_KEYWORD_RE가 왜 매치됐는지 사람이 바로 알아볼 수 있도록
// title/본문에서 가장 먼저 매치되는 패턴 하나를 골라 boothType 필드에 남긴다.
const BOOTH_TYPE_PATTERNS = [
  ["프리마켓", /프리마켓/],
  ["플리마켓", /플리마켓/],
  ["푸드트럭", /푸드트럭/],
  ["먹거리부스", /먹거리\s*부스|식음료\s*부스|먹거리\s*장터/],
  ["체험부스", /체험\s*부스/],
  ["판매부스", /판매\s*부스|판매자\s*모집|참여상인\s*모집/],
  ["셀러모집", /셀러\s*모집|셀러모집/],
  ["나눔장터", /나눔장터/],
  ["주말장터", /주말장터/],
  ["벼룩시장", /벼룩시장/],
  ["부스모집", /부스\s*모집|부스\s*참가|부스\s*운영(?:자|업체)|입점\s*(?:모집|업체)|참가업체\s*모집|참여업체\s*모집/],
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

// 2026-10-22 신설: "관리자 승인" 없이도 홈페이지에 자동 반영해도 안전한 공고인지 판정.
// 관리자 화면은 공개 배포 사이트에서 보안상 비활성화돼 있어(요청사항, 해제하지 않음),
// 사람이 눌러서 승인하는 경로 자체가 없다 — 그래서 "실제 셀러·푸드트럭·체험부스·
// 프리마켓 모집공고로 확실히 분류된 것"만 자동으로 status:"approved"를 주고, 그 외
// (noticeType이 general/review/미분류)는 전부 "pending"으로 남겨 홈페이지에 노출하지
// 않는다. 신청기간·참가자격 확인 여부는 여기서 보지 않는다 — 그건 홈페이지 쪽
// getStatus()가 "확인 필요" 표시로 이미 안전하게 처리하므로, 날짜가 비어 있어도
// (noticeType이 확실하면) 공고 자체는 노출해 셀러가 원문을 직접 확인할 수 있게 한다.
//   조건: noticeType === "recruit" (제목에 부스/셀러 모집 키워드가 명확히 있어야만
//         classifyNotice가 매기는 값 — "review"/"general"은 절대 대상 아님)
//       AND boothType이 null이 아님(판매부스/체험부스/프리마켓/푸드트럭 등으로 실제
//         분류된 경우만 — 방어적 이중 확인, 이론상 recruit면 항상 채워져 있음)
function decideAutoPublishStatus(cls) {
  if (cls.noticeType === "recruit" && cls.boothType) return "approved";
  return "pending";
}

function parseKoDate(s) {
  const m = s.replace(/\s/g, "").match(/(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return isNaN(d.getTime()) ? null : d;
}

function parseKoMonthDay(monthStr, dayStr, year) {
  const d = new Date(Date.UTC(year, +monthStr - 1, +dayStr));
  return isNaN(d.getTime()) ? null : d;
}

// postedDate는 게시판마다 표기가 다를 수 있어("2026-10-21", "2026.10.13" 등) 항상
// YYYY-MM-DD로 맞춘다. 파싱 실패 시 null(추측하지 않음).
function normalizePostedDate(s) {
  if (!s) return null;
  const m = String(s)
    .replace(/\s/g, "")
    .match(/(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

// 2026-10-22 신설: 게시판 목록에서 postedDate를 못 캡처했을 때, 공고문(PDF/본문) 자체에
// 박힌 "공고일"을 대신 찾는다. 정부 공고문은 관례적으로 본문 끝·서명란(시장/군수 등)
// 바로 위에 "YYYY년 M월 D일" 형태로 공고일을 단독으로 적어둔다(경주 윈터포차라이트
// PDF를 실제로 받아 "2026년 10월 19일" 한 줄을 확인함). 문서에서 가장 먼저 나오는
// 이 형태의 날짜 하나만 쓴다 — 본문 뒷부분의 다른 "YYYY년"(예: "2026년 행사 영업을
// 위한")은 뒤에 "월...일"이 바로 이어지지 않아 매치되지 않으므로 오탐 위험이 낮다.
const NOTICE_SELF_DATE_RE = /(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/;
function extractSelfDeclaredNoticeDate(text) {
  const m = text.match(NOTICE_SELF_DATE_RE);
  if (!m) return null;
  return `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
}

// 2026-10-22 신설: 게시판 목록에서 postedDate를 못 캡처했을 때, 상세페이지 본문 안에
// 흔히 있는 "등록일 : 2026-05-13" 같은 자체 날짜 표기를 대신 찾는다(덕신온마켓
// 셀러모집 실측 사례 — 목록 추출기가 날짜를 못 가져왔지만 본문엔 등록일이 그대로
// 있었음). 연도 없는 "O월 O일" 날짜의 기준점(postedDate)을 넓게 확보하기 위함.
const POSTED_DATE_BODY_RE =
  /(?:등록일|게시일|작성일|등록\s*일자|게시\s*일자)\s*(?:[:：]|\))\s*(\d{4})[.\-/]\s*(\d{1,2})[.\-/]\s*(\d{1,2})/;
function extractPostedDateFromBody(text) {
  const m = text.match(POSTED_DATE_BODY_RE);
  if (!m) return null;
  return `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
}

// 2026-10-22 신설: "O월 O일"처럼 연도 없이 적힌 날짜에 실행 시점(수집 당일)의 연도를
// 그냥 붙이던 기존 방식은, 수집이 연말연초에 걸리면 완전히 다른 연도를 가리킬 수 있어
// 위험함(예: 12월에 수집한 공고가 "1월 5일까지"라면 올해가 아니라 내년을 가리킴).
// 대신 그 공고의 게시일(postedDate — 목록 또는 본문 "등록일"에서 확인된 값)을
// 기준으로 삼는다: 모집기간은 상식적으로 게시일 당일이거나 그 이후에 시작하므로,
// 계산한 날짜가 게시일보다 60일 이상 이전이면 다음 해를 가리키는 것으로 보정한다.
// 기준으로 쓸 게시일 자체가 없으면(목록·본문 모두 못 찾음) 추측할 근거가 전혀
// 없으므로 null을 돌려주고, 호출한 쪽에서 "확인 필요"로 남긴다(추측 금지 원칙).
function resolveYearlessMonthDay(month, day, referenceDateStr) {
  if (!referenceDateStr) return null;
  const ref = parseKoDate(referenceDateStr);
  if (!ref) return null;
  const year = ref.getUTCFullYear();
  let candidate = parseKoMonthDay(month, day, year);
  if (!candidate) return null;
  if (candidate.getTime() < ref.getTime() - 60 * 24 * 60 * 60 * 1000) {
    candidate = parseKoMonthDay(month, day, year + 1);
  }
  return candidate;
}

// 본문에서 신청기간을 뽑아내는 3단계 폴백 — 위에서 아래로 시도하며, 먼저 성공한 패턴을
// 쓴다. 1), 2)는 시작일·마감일이 둘 다 확정될 때만 open/upcoming/closed를 계산하고,
// 3)은 마감일만 있으므로 "이미 지났는지"만 판정하며 그 전이면 "모집중"이라 단정하지
// 않고 unknown으로 남긴다(2026-10-17 신설, 날짜 표현 다양화 개선).
function extractDateRange(bodyText, postedDate) {
  const out = { applyStart: null, applyEnd: null, recruitStatus: "unknown" };
  const today = new Date();
  // 2026-10-22: 연도 없는 "O월 O일" 날짜를 해석할 기준점 — 목록에서 못 가져왔으면
  // 본문의 "등록일" 표기, 그마저 없으면 공고문 자체에 박힌 "YYYY년 M월 D일" 표기까지
  // 순서대로 찾는다. 셋 다 없으면 null — 이 경우 아래 kmd 관련 분기들은 전부
  // 추측하지 않고 그대로 통과한다(최종적으로 "확인 필요"로 남음).
  const referenceDate = postedDate || extractPostedDateFromBody(bodyText) || extractSelfDeclaredNoticeDate(bodyText);

  const rangeMatch = bodyText.match(DATE_RANGE_RE);
  if (rangeMatch) {
    const start = parseKoDate(rangeMatch[1]);
    const end = parseKoDate(rangeMatch[2]);
    if (start && end) {
      // 2026-10-22 수정: 원문 구분자("." 등)를 그대로 두면 "2026.8.30" 같은 값이 나와
      // 프런트엔드의 new Date(s+"T00:00:00") 파싱이 깨짐(Invalid Date -> 조용히 "확인
      // 필요"로만 보임, 실측으로 발견) — 항상 YYYY-MM-DD로 통일한다.
      out.applyStart = normalizePostedDate(rangeMatch[1]);
      out.applyEnd = normalizePostedDate(rangeMatch[2]);
      out.recruitStatus = today < start ? "upcoming" : today > end ? "closed" : "open";
      return out;
    }
  }

  const kmdMatch = bodyText.match(KOREAN_MONTH_DAY_RANGE_RE);
  if (kmdMatch) {
    const start = resolveYearlessMonthDay(kmdMatch[1], kmdMatch[2], referenceDate);
    const end = resolveYearlessMonthDay(kmdMatch[3], kmdMatch[4], referenceDate);
    if (start && end && end >= start) {
      out.applyStart = `${start.getUTCFullYear()}-${String(kmdMatch[1]).padStart(2, "0")}-${String(kmdMatch[2]).padStart(2, "0")}`;
      out.applyEnd = `${end.getUTCFullYear()}-${String(kmdMatch[3]).padStart(2, "0")}-${String(kmdMatch[4]).padStart(2, "0")}`;
      out.recruitStatus = today < start ? "upcoming" : today > end ? "closed" : "open";
      return out;
    }
  }

  const numericMdMatch = bodyText.match(NUMERIC_MONTH_DAY_RANGE_RE);
  if (numericMdMatch) {
    const start = resolveYearlessMonthDay(numericMdMatch[1], numericMdMatch[2], referenceDate);
    const end = resolveYearlessMonthDay(numericMdMatch[3], numericMdMatch[4], referenceDate);
    if (start && end && end >= start) {
      out.applyStart = `${start.getUTCFullYear()}-${String(numericMdMatch[1]).padStart(2, "0")}-${String(numericMdMatch[2]).padStart(2, "0")}`;
      out.applyEnd = `${end.getUTCFullYear()}-${String(numericMdMatch[3]).padStart(2, "0")}-${String(numericMdMatch[4]).padStart(2, "0")}`;
      out.recruitStatus = today < start ? "upcoming" : today > end ? "closed" : "open";
      return out;
    }
  }

  const deadlineMatch = bodyText.match(DATE_DEADLINE_ONLY_RE);
  if (deadlineMatch) {
    const raw = deadlineMatch[1] || deadlineMatch[2];
    const end = parseKoDate(raw);
    if (end) {
      out.applyEnd = normalizePostedDate(raw); // 형식 통일(위 DATE_RANGE_RE와 같은 이유)
      // 시작일을 모르므로 "이미 마감됐는지"만 확정하고, 안 지났으면 모집중이라 단정하지
      // 않고 unknown 유지.
      out.recruitStatus = today > end ? "closed" : "unknown";
      return out;
    }
  }

  const kmdDeadlineMatch = bodyText.match(KOREAN_MONTH_DAY_DEADLINE_RE);
  if (kmdDeadlineMatch) {
    const end = resolveYearlessMonthDay(kmdDeadlineMatch[1], kmdDeadlineMatch[2], referenceDate);
    if (end) {
      out.applyEnd = `${end.getUTCFullYear()}-${String(kmdDeadlineMatch[1]).padStart(2, "0")}-${String(kmdDeadlineMatch[2]).padStart(2, "0")}`;
      out.recruitStatus = today > end ? "closed" : "unknown";
      return out;
    }
  }

  // 2026-10-21 추가: "접수기간: 공고일 ~ M.D" 형태(경주 사례로 실측) — 시작일을 "공고일"
  // 이라는 말로만 표현해 위 패턴들이 못 잡던 경우. 공고가 이미 게시됐다는 사실 자체가
  // "모집이 시작됐다"는 근거이지만, 그 시작일이 정확히 언제인지는 게시판에서 postedDate를
  // 캡처했을 때만 안다 — postedDate가 없으면 시작일을 비워두고(확인 필요 유지),
  // "이미 마감됐는지"만 판정한다(2026-10-22 수정: postedDate 없이 "open"이라 단정하던
  // 이전 동작은 "신청 시작일을 확인할 수 있는 항목만 모집중으로 분류" 요구사항과
  // 어긋나서 더 엄격하게 고침).
  const announceMatch = bodyText.match(APPLY_PERIOD_ANNOUNCE_RE);
  if (announceMatch) {
    const [, endYearRaw, endMonth, endDay] = announceMatch;
    // 2026-10-22 수정: 연도가 본문에 명시되지 않은 경우, 실행 시점 연도를 쓰던 것을
    // referenceDate(공고 게시일) 기준 보정으로 바꿈 — 위 kmd 분기들과 같은 이유.
    const end = endYearRaw
      ? parseKoMonthDay(endMonth, endDay, +endYearRaw)
      : resolveYearlessMonthDay(endMonth, endDay, referenceDate);
    if (end) {
      out.applyStart = normalizePostedDate(postedDate) || extractSelfDeclaredNoticeDate(bodyText);
      out.applyEnd = `${end.getUTCFullYear()}-${String(endMonth).padStart(2, "0")}-${String(endDay).padStart(2, "0")}`;
      if (today > end) {
        out.recruitStatus = "closed";
      } else if (out.applyStart) {
        out.recruitStatus = "open";
      } else {
        out.recruitStatus = "unknown";
      }
    }
  }

  return out;
}

// 관외(타지역) 사업자 참가 가능 여부 판정 (2026-10-17 신설). boardRegion은 게시판이
// 속한 지역(예: "경북"/"경남") — 그 게시판 자체가 "울산"이면 "관내"가 곧 울산이므로,
// "관내만 가능"이라는 문구가 오히려 울산 사업자에겐 유리하다는 점을 반영한다.
// 2026-10-21: "전국 업체 참가 가능 / 지역 업체 한정(+제한 지역명) / 참가 자격 확인 필요"
// 3분류를 eligibilityCategory/restrictedRegion으로 새로 추가(기존 ulsanEligible은 그대로
// 둬서 울산 우선 확인 기능 등 기존 동작을 깨지 않음). "행사 개최 지역"과 "참가업체 사업장
// 소재지 제한"을 혼동하지 않도록, 지역명은 반드시 "~에 사업장을 둔/관내~" 류 참가자격
// 문구에서만 뽑고, 게시판 자체의 region(개최 지역)에서는 절대 추론하지 않는다.
function detectEligibility(bodyText, boardRegion) {
  if (!bodyText) {
    return { eligibility: null, ulsanEligible: "unknown", eligibilityCategory: "unknown", restrictedRegion: null };
  }
  const outsideOk = ELIGIBILITY_OUTSIDE_OK_RE.exec(bodyText);
  const outsideNo = ELIGIBILITY_OUTSIDE_NO_RE.exec(bodyText);
  const localBiz = ELIGIBILITY_LOCAL_BIZ_RE.exec(bodyText);

  if (outsideOk && !outsideNo) {
    return {
      eligibility: outsideOk[0].replace(/\s+/g, " "),
      ulsanEligible: "yes",
      eligibilityCategory: "nationwide",
      restrictedRegion: null,
    };
  }
  if (outsideNo && !outsideOk) {
    const quote = outsideNo[0].replace(/\s+/g, " ");
    const regionMatch = /([가-힣]{2,6}(?:시|군|구))에\s*(?:주소를\s*둔|소재한|거주하는)/.exec(bodyText);
    return {
      eligibility: quote,
      ulsanEligible: boardRegion === "울산" ? "yes" : "no",
      eligibilityCategory: "local_only",
      restrictedRegion: regionMatch ? regionMatch[1] : null,
    };
  }
  // 2026-10-21 추가: "OO시에 사업장을 둔/두고" — "만"/"한정" 같은 명시적 단어는 없지만
  // 특정 지자체를 참가 전제조건으로 못박아 실질적으로 관내 한정인 경우(경주 사례로 실측
  // 확인). outsideOk/outsideNo가 둘 다 안 걸렸을 때만 보는 마지막 폴백.
  if (localBiz && !outsideOk) {
    return {
      eligibility: localBiz[0].replace(/\s+/g, " ").trim(),
      ulsanEligible: boardRegion === "울산" ? "yes" : "no",
      eligibilityCategory: "local_only",
      restrictedRegion: localBiz[1] || localBiz[2] || localBiz[3] || localBiz[4],
    };
  }
  // 근거 문구가 없거나 모순되게 여러 패턴이 동시에 매치되면 — 추측하지 않고 unknown 유지
  return { eligibility: null, ulsanEligible: "unknown", eligibilityCategory: "unknown", restrictedRegion: null };
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

// 2026-10-21 신설: 위 stripHtml()은 날짜/자격 판정용으로 전부 공백 한 줄로 뭉개는데,
// "행사명 : ... / 행사장소 : ... / 모집규모 : ..." 처럼 한 줄에 한 항목인 공고는 줄바꿈이
// 없어지면 값이 다음 항목까지 전부 삼켜버리는 문제가 실측으로 확인됨(경주 사례). 신규
// 상세필드(행사명/장소/모집규모/참가비/신청방법) 추출에만 쓰는 별도 버전으로, <br>·블록
// 종료태그를 줄바꿈으로 바꿔서 "한 줄 = 한 항목" 구조를 보존한다. 기존 stripHtml()은
// 그대로 둬서(날짜·자격판정 등 기존 50여개 기관에서 이미 검증된 동작) 회귀 위험이 없다.
function stripHtmlPreserveLines(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|dd|dt|tr|td|th|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

// ---- 2026-10-21 신설, 2026-10-22 HWPX·HWP 추가: 공식 첨부파일(PDF·HWPX·HWP) 분석 ----
// 비용 조사 결과(사용자 승인 완료): pdf-parse는 무료 오픈소스라 외부 API 호출/비용이
// 전혀 없음. .hwpx(2014년 이후 신형, ZIP+XML 컨테이너)는 Node 내장 zlib만으로 직접
// 풀어 읽는다. .hwp(구 바이너리, ~2014년 이전)는 "무료 파서가 없다"고 판단해 오랫동안
// 미지원이었으나, 2026-10-22 재검증 요청으로 실제 가능함을 확인 — CFBF(옛 MS
// Office와 같은 복합 바이너리 컨테이너) + HWP5 본문 레코드 구조를 직접 파싱하는
// 전용 코드를 새로 작성해 외부 라이브러리 없이 지원한다(아래 parseCFBF/
// extractHwp5BodyText 참고, 2026 울산옹기축제 플리마켓 모집 공고 실제 .hwp 파일로
// 텍스트 추출 결과가 공식 모집기간·참가비·신청방법과 정확히 일치함을 실측 검증함).
const DIRECT_ATTACHMENT_LINK_RE = /<a[^>]+href="([^"]+\.(pdf|hwpx|hwp))"[^>]*>/gi;
// 2026-10-22 신설: 그누보드5 계열(이 프로젝트에서 이미 여러 재단·소규모 기관 사이트가
// 쓰는 것으로 확인된 CMS)은 다운로드 링크가 "bbs/download.php?...&nonce=..." 형태라
// href에 확장자가 없고, 파일명은 링크 "텍스트"에만 있음(울주문화재단 실측 확인) — 이
// 경우를 위한 보조 패턴. href 기반으로 못 찾았을 때만 보조로 쓴다.
// href가 "#..." 같은 페이지 내 앵커(클릭은 onclick의 JS가 처리)인 경우는 실제
// 다운로드 URL이 아니므로 제외 — 영주시청·경주시청(openDownloadFiles 계열)이 바로
// 이런 구조라, 이 규칙이 없으면 onclick을 무시하고 쓸모없는 "#downFiles_NNN"을
// 다운로드 URL로 잘못 채택해 더 구체적인 OPENDOWNLOADFILES_RE 분기까지 못 갔음
// (영주시청 자원재활용 한마당 모집 공고 실측으로 발견).
const ATTACHMENT_TEXT_LINK_RE = /<a[^>]+href="([^"#][^"]*)"[^>]*>\s*([^<]{1,200}?\.(pdf|hwpx|hwp))\s*<\/a>/gi;
// eminwon(경주 등 NTIS 계열 게시판)의 첨부파일은 onclick="goDownLoad('표시이름','저장이름',
// '경로',파일ID)"로 다운로드되고, 실제 다운로드 URL은 그 사이트의 외부 js(utility.js)에
// 박혀 있는 "eminwon.<도메인>/emwp/jsp/ofr/FileDown.jsp?..." 패턴으로 역추적해 확인함
// (경주 윈터포차라이트 PDF를 실제로 받아 pdf-parse로 100% 정확하게 읽어냄 — 비용 보고
// 단계에서 실측 검증 완료).
// 2026-10-23 수정: 북구청 eminwon(헤드리스 브라우저로 렌더링해 실측)은 같은
// goDownLoad() 함수를 인자 3개(파일ID 없이)로만 호출함 — 기존 4번째 숫자 인자를
// 선택적으로 바꿔 두 형태 모두 잡음(URL 조립에는 원래부터 1~3번째 인자만 씀).
const GODOWNLOAD_RE = /goDownLoad\('([^']+)'\s*,\s*'([^']+)'\s*,\s*'([^']+)'(?:\s*,\s*\d+)?\)/g;
// 2026-10-22 신설: 영주시청·경주시청이 공유하는 CMS(같은 /design/common/js/utility.js)
// 계열은 onclick="openDownloadFiles(파일ID)"로 다운로드하고, 실제 다운로드 URL은
// utility.js에 박혀 있는 "/programs/board/download.do?parm_file_uid=<파일ID>" 패턴
// (실측 확인 — 쿠키·Referer 불필요, goDownLoad와 달리 훨씬 단순함). 파일명은 같은
// <a> 태그의 title 속성("...파일명.ext 다운로드")에 있음.
const OPENDOWNLOADFILES_RE =
  /<a[^>]*onclick="openDownloadFiles\((\d+)[^)]*\)[^"]*"[^>]*title="([^"]+?\.(hwp|hwpx|pdf))\s*다운로드"/gi;
// 2026-10-23 신설: 울산 중구청(board/view.ulsan 계열) 첨부파일 — href는 바로
// "/board/download.ulsan?...&fileSid=N" 형태라 쿠키·Referer 없이 그대로 받을 수
// 있지만(실측 확인), 파일명이 <a> 안의 <img> 다음 <span>에 있어(사이에 태그가
// 끼어 있음) 기존 ATTACHMENT_TEXT_LINK_RE([^<]+ 로 텍스트만 찾음)가 못 잡음.
const JUNGGU_FILE_RE =
  /<a href="(\/board\/download\.ulsan\?[^"]+)"[^>]*class="file"[^>]*>[\s\S]{0,150}?<span>([^<]+\.(pdf|hwpx|hwp))/gi;
// 2026-10-23 신설: 울산쇠부리축제(soeburi.org, XpressEngine) 첨부파일 — 다운로드
// href가 "...act=procFileDownload..." 형태(확장자로 끝나지 않음)라 DIRECT_ATTACHMENT_
// LINK_RE가 못 잡고, 파일명 뒤에 "<span class=\"fileSize\">...</span>"가 바로 붙어 있어
// (사이에 태그가 끼어 있음) ATTACHMENT_TEXT_LINK_RE([^<]+뒤에 곧장 </a>를 요구)도 못
// 잡는다(실측 확인). 또한 이 사이트는 "첨부"가 아니라 "붙임"이라는 글자를 쓰므로
// 2000자 스코핑도 적용되지 않음(아래 extractAttachmentPdfUrls의 attachIdx 계산에서
// 둘 다 안 걸려 전체 html을 보게 됨 — 의도한 동작).
const SOEBURI_FILE_RE =
  /<a href="([^"]*act=procFileDownload[^"]*)"[^>]*>\s*(?:\[[^\]]*\]\s*)?([^<]{1,200}?\.(pdf|hwpx|hwp))/gi;

function attachmentKindOf(filename) {
  if (/\.hwpx$/i.test(filename)) return "hwpx";
  if (/\.hwp$/i.test(filename)) return "hwp";
  if (/\.pdf$/i.test(filename)) return "pdf";
  return null;
}

// 반환값이 과거엔 URL 문자열 배열이었는데, 이제 형식(pdf/hwpx/hwp)별로 다른 방식으로
// 받아와야 해서 {url, kind} 객체 배열로 바꿈 — 유일한 호출부(fetchAttachmentPdfText)도
// 같이 수정함.
function extractAttachmentPdfUrls(html, pageUrl) {
  const out = [];
  let m;
  // 2026-10-22 수정: 본문과 무관한 사이드바/메뉴의 .pdf 링크(실측 사례: 울주군청
  // 통합검색 게시판에서 "덕신온마켓 셀러모집" 글을 열었는데, 사이드바 메뉴의 "사회
  // 복지시설현황" PDF가 첨부파일로 잘못 잡힘 — 그 글에는 실제로 PDF 첨부가 없고 포스터
  // 이미지(.png)만 있었음)를 막기 위해, "첨부"라는 글자가 있으면 그 지점 이후에서만
  // PDF 링크를 찾는다("첨부파일" 영역은 보통 본문 뒤쪽에 있고, 사이드바/메뉴는 그 앞에
  // 있는 경우가 많음). "첨부" 글자 자체가 없는 페이지(예: eminwon 계열)는 기존처럼
  // 전체 HTML에서 찾아 기존 동작을 그대로 유지한다.
  // "첨부"가 여러 번 나올 수 있어(실측: 울주군청 페이지는 본문 첨부파일 영역과 전혀
  // 무관한 꼬리말/위젯에도 같은 글자가 또 나옴) 첫 등장 지점부터 끝까지가 아니라, 실제
  // 첨부파일 목록이 보통 들어가는 2000자 이내로만 범위를 좁힌다.
  // 2026-10-23 수정: 중구청(junggu.ulsan.kr)은 실제 첨부파일 영역(class="file_wrap")이
  // 본문보다 먼저 나오고, 본문 안의 "첨부파일을 참고하시기 바랍니다" 같은 안내 문구가
  // 오히려 더 나중에 나와 "첨부"의 첫 등장 지점만 보면 실제 첨부 영역을 지나쳐버림
  // (실측 확인). "첨부"와 "file_wrap"(또는 class="file") 중 더 앞쪽에 있는 지점을
  // 기준으로 삼아 이런 순서 역전에도 영역을 놓치지 않게 한다.
  const attachKeywordIdx = html.indexOf("첨부");
  const fileWrapIdx = html.search(/class="file(_wrap|_zone|")/);
  const candidates = [attachKeywordIdx, fileWrapIdx].filter((i) => i !== -1);
  const attachIdx = candidates.length ? Math.min(...candidates) : -1;
  const searchHtml = attachIdx !== -1 ? html.slice(attachIdx, attachIdx + 2000) : html;
  const direct = new RegExp(DIRECT_ATTACHMENT_LINK_RE.source, "gi");
  while ((m = direct.exec(searchHtml))) {
    try {
      out.push({ url: new URL(decodeEntities(m[1]), pageUrl).href, kind: attachmentKindOf(m[1]) });
    } catch {
      /* ignore malformed href */
    }
  }
  if (out.length) return out.slice(0, 2);

  const textLink = new RegExp(ATTACHMENT_TEXT_LINK_RE.source, "gi");
  while ((m = textLink.exec(searchHtml))) {
    try {
      out.push({ url: new URL(decodeEntities(m[1]), pageUrl).href, kind: attachmentKindOf(m[2]) });
    } catch {
      /* ignore malformed href */
    }
  }
  if (out.length) return out.slice(0, 2);

  const openDl = new RegExp(OPENDOWNLOADFILES_RE.source, "gi");
  while ((m = openDl.exec(searchHtml))) {
    const kind = attachmentKindOf(m[2]);
    if (!kind) continue;
    try {
      const origin = new URL(pageUrl).origin;
      out.push({ url: `${origin}/programs/board/download.do?parm_file_uid=${m[1]}`, kind });
    } catch {
      /* ignore */
    }
  }
  if (out.length) return out.slice(0, 2);

  const jungguFile = new RegExp(JUNGGU_FILE_RE.source, "gi");
  while ((m = jungguFile.exec(searchHtml))) {
    const kind = attachmentKindOf(m[2]);
    if (!kind) continue;
    try {
      out.push({ url: new URL(decodeEntities(m[1]), pageUrl).href, kind });
    } catch {
      /* ignore */
    }
  }
  if (out.length) return out.slice(0, 2);

  const soeburiFile = new RegExp(SOEBURI_FILE_RE.source, "gi");
  while ((m = soeburiFile.exec(searchHtml))) {
    const kind = attachmentKindOf(m[2]);
    if (!kind) continue;
    try {
      out.push({ url: new URL(decodeEntities(m[1]), pageUrl).href, kind });
    } catch {
      /* ignore */
    }
  }
  if (out.length) return out.slice(0, 2);

  // 2026-10-23 수정: eminwon 상세 페이지는 goDownLoad() 함수 "정의"(실제 데이터가
  // 아닌 코드) 안에 "첨부"라는 글자가 먼저 나오고, 실제 호출(실제 파일명)은 그보다
  // 수천 자 뒤에 있어(실측: 북구청 id=45217 — "첨부" 1773번째 글자, 실제 호출은
  // 8041번째 글자) 위 2000자 윈도(searchHtml)로는 못 찾는다. GODOWNLOAD_RE는 이
  // 함수 호출 형태 자체가 매우 구체적(파일명 3~4개 인자)이라 다른 영역에서 우연히
  // 매칭될 위험이 거의 없으므로, 이 패턴만 전체 html에서 찾는다(다른 패턴들의 2000자
  // 스코핑 동작은 그대로 유지 — 회귀 위험 없음).
  const godown = new RegExp(GODOWNLOAD_RE.source, "g");
  while ((m = godown.exec(html))) {
    const [, userFileNm, sysFileNm, filePath] = m;
    const kind = attachmentKindOf(userFileNm);
    if (!kind) continue; // 이미지 등 지원 안 하는 형식 — 확인 필요로 남김
    try {
      // 2026-10-23 수정: pageUrl이 이미 eminwon.* 호스트(이번에 새로 추가한 북구청·
      // 동구청·남구청 고시공고 상세 URL)인 경우 "eminwon."을 또 붙이면
      // "eminwon.eminwon.xxx"가 돼버림 — 이미 eminwon.으로 시작하면 그대로 쓴다.
      const rawHost = new URL(pageUrl).hostname.replace(/^www\./, "");
      const host = rawHost.startsWith("eminwon.") ? rawHost : `eminwon.${rawHost}`;
      const url =
        `https://${host}/emwp/jsp/ofr/FileDown.jsp?` +
        `user_file_nm=${encodeURI(decodeEntities(userFileNm))}` +
        `&sys_file_nm=${encodeURI(decodeEntities(sysFileNm))}` +
        `&file_path=${encodeURI(decodeEntities(filePath))}`;
      out.push({ url, kind });
    } catch {
      /* ignore */
    }
  }
  return out.slice(0, 2);
}

// PDF를 받아 텍스트만 뽑는다 — 실패(네트워크·암호화·손상 등)는 전부 조용히 무시하고
// null을 반환, 호출 쪽에서 "본문만으로 분류"로 안전하게 폴백한다(절대 전체 수집을
// 중단시키지 않음).
async function fetchPdfText(pdfUrl) {
  try {
    const res = await fetch(pdfUrl, {
      headers: { "User-Agent": BROWSER_UA },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 15 * 1024 * 1024) return null; // 비정상적으로 큰 파일은 스킵
    const parser = new PDFParse({ data: buf });
    const { text } = await parser.getText();
    return text || null;
  } catch {
    return null;
  }
}

// 2026-10-22 신설: .hwpx(한글 2014+ 신형 포맷)는 내부적으로 ZIP 컨테이너이고, 본문은
// Contents/section0.xml(여러 섹션이면 section1.xml...) 안에 <hp:p>문단</hp:p>,
// <hp:t>텍스트</hp:t> 구조로 들어있다. 외부 압축 라이브러리 없이 Node 내장
// zlib.inflateRawSync만으로 ZIP의 central directory를 직접 읽어 해당 엔트리만
// 꺼낸다 — 전체 압축을 풀 필요 없이 필요한 XML 파트만 읽어 가볍다.
function readZipCentralDirectory(buf) {
  const EOCD_SIG = 0x06054b50;
  const searchFrom = Math.max(0, buf.length - 22 - 65536);
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= searchFrom; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) return [];
  const entryCount = buf.readUInt16LE(eocdOffset + 10);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);
  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < entryCount && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const compMethod = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localHeaderOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    entries.push({ name, compMethod, compSize, localHeaderOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
function readZipEntryData(buf, entry) {
  const p = entry.localHeaderOffset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== 0x04034b50) return null;
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const dataStart = p + 30 + nameLen + extraLen;
  const raw = buf.subarray(dataStart, dataStart + entry.compSize);
  if (entry.compMethod === 0) return raw; // 저장만(비압축)
  if (entry.compMethod === 8) {
    try {
      return zlib.inflateRawSync(raw);
    } catch {
      return null;
    }
  }
  return null; // 지원하지 않는 압축 방식(드묾) — 조용히 포기
}
function hwpxXmlToText(xml) {
  return xml
    .replace(/<\/hp:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}
async function fetchHwpxText(url) {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": BROWSER_UA },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 15 * 1024 * 1024) return null;
    const entries = readZipCentralDirectory(buf)
      .filter((e) => /Contents\/section\d+\.xml/i.test(e.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!entries.length) return null;
    const texts = [];
    for (const entry of entries) {
      const data = readZipEntryData(buf, entry);
      if (!data) continue;
      const text = hwpxXmlToText(data.toString("utf8"));
      if (text) texts.push(text);
    }
    return texts.length ? texts.join("\n") : null;
  } catch {
    return null;
  }
}

// 2026-10-22 신설: 그누보드5 계열의 "bbs/download.php?...&nonce=..." 다운로드는 목록/
// 상세 페이지를 받아온 바로 그 요청의 세션 쿠키 + Referer가 없으면 "잘못된 접근입니다"
// 오류 페이지만 돌려줌(울주문화재단 실측 확인 — 쿠키·Referer 없이 보낸 첫 시도는
// 실패했고, 상세페이지를 다시 받아 그 응답의 Set-Cookie를 그대로 넘기자 성공함).
// 본문 분류용 메인 fetchText(detailUrl) 호출은 그대로 두고(기존 재시도 로직 보존,
// 회귀 위험 없음), hwp 첨부파일이 실제로 있을 때만 쿠키 확보용으로 한 번 더 가볍게
// 받아온다.
async function fetchTextWithCookie(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": BROWSER_UA },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { text: await res.text(), cookie: res.headers.get("set-cookie") || null };
}

// ---- 2026-10-22 신설: 구형 .hwp(바이너리) 첨부파일 분석 ----
// .hwp 파일은 옛 MS Office(.doc/.xls)와 같은 CFBF(Compound File Binary Format)
// 컨테이너이고, 본문 텍스트는 그 안의 "BodyText/SectionN" 스트림에 HWP5 전용 레코드
// 구조로 들어있다. 외부 라이브러리 없이 Node 내장 zlib(raw deflate)만으로 직접
// 해석한다 — 2026 울산옹기축제 플리마켓 모집 공고의 실제 .hwp 파일로 전체 흐름을
// 검증했고, 추출된 모집기간·참가비·신청방법이 공식 공고 내용과 정확히 일치함을
// 확인함(추측이 아니라 실제 바이너리 디코딩 결과).
const CFBF_SIG = 0xd0cf11e0a1b11ae1n;
const CFBF_FREESECT = 0xffffffff;
const CFBF_ENDOFCHAIN = 0xfffffffe;

function parseCFBF(buf) {
  if (buf.length < 512 || buf.readBigUInt64BE(0) !== CFBF_SIG) return null;
  const sectorShift = buf.readUInt16LE(30);
  const miniSectorShift = buf.readUInt16LE(32);
  const sectorSize = 1 << sectorShift;
  const miniSectorSize = 1 << miniSectorShift;
  const firstDirSector = buf.readUInt32LE(48);
  const miniStreamCutoff = buf.readUInt32LE(56);
  const firstMiniFatSector = buf.readUInt32LE(60);
  const numMiniFatSectors = buf.readUInt32LE(64);
  const firstDifatSector = buf.readUInt32LE(68);

  const sectorOffset = (n) => 512 + n * sectorSize;
  const readSector = (n) => buf.subarray(sectorOffset(n), sectorOffset(n) + sectorSize);

  // DIFAT: 헤더 안 109개 + (드물게) 체인으로 이어지는 추가 DIFAT 섹터.
  const difat = [];
  for (let i = 0; i < 109; i++) difat.push(buf.readUInt32LE(76 + i * 4));
  let difatSector = firstDifatSector;
  let guard = 0;
  while (difatSector < 0xfffffffc && guard++ < 10000) {
    const sec = readSector(difatSector);
    const perSector = sectorSize / 4;
    for (let i = 0; i < perSector - 1; i++) difat.push(sec.readUInt32LE(i * 4));
    difatSector = sec.readUInt32LE((perSector - 1) * 4);
  }

  // FAT: DIFAT가 가리키는 섹터들을 이어붙인 것 — 섹터 번호 -> 다음 섹터 번호.
  const fat = [];
  for (const fatSecNum of difat) {
    if (fatSecNum >= 0xfffffffc) continue;
    const sec = readSector(fatSecNum);
    for (let i = 0; i < sectorSize / 4; i++) fat.push(sec.readUInt32LE(i * 4));
  }

  function followChain(startSector, knownSize) {
    const chunks = [];
    let s = startSector;
    let g = 0;
    while (s < 0xfffffffc && g++ < 200000) {
      chunks.push(readSector(s));
      s = fat[s];
    }
    let out = Buffer.concat(chunks);
    if (knownSize !== undefined && knownSize < out.length) out = out.subarray(0, knownSize);
    return out;
  }

  // 디렉터리 스트림 — 128바이트짜리 엔트리가 연이어 있음.
  const dirBuf = followChain(firstDirSector);
  const DIRENT_SIZE = 128;
  const entries = [];
  for (let i = 0; i + DIRENT_SIZE <= dirBuf.length; i += DIRENT_SIZE) {
    const nameLenBytes = dirBuf.readUInt16LE(i + 64);
    const nameLenChars = nameLenBytes > 0 ? nameLenBytes / 2 - 1 : 0;
    const name = nameLenChars > 0 ? dirBuf.toString("utf16le", i, i + nameLenChars * 2) : "";
    entries.push({
      name,
      type: dirBuf.readUInt8(i + 66),
      leftSib: dirBuf.readUInt32LE(i + 68),
      rightSib: dirBuf.readUInt32LE(i + 72),
      childId: dirBuf.readUInt32LE(i + 76),
      startSector: dirBuf.readUInt32LE(i + 116),
      size: dirBuf.readUInt32LE(i + 120),
    });
  }
  if (!entries.length) return null;
  const root = entries[0];

  // 미니스트림(루트 엔트리가 가리키는, 작은 스트림들을 모아둔 영역)과 미니FAT.
  const miniStreamData = root.startSector < 0xfffffffc ? followChain(root.startSector, root.size) : Buffer.alloc(0);
  const miniFat = [];
  if (numMiniFatSectors > 0) {
    const miniFatBuf = followChain(firstMiniFatSector);
    for (let i = 0; i < miniFatBuf.length / 4; i++) miniFat.push(miniFatBuf.readUInt32LE(i * 4));
  }
  function followMiniChain(startSector, knownSize) {
    const chunks = [];
    let s = startSector;
    let g = 0;
    while (s < 0xfffffffc && g++ < 200000) {
      const off = s * miniSectorSize;
      chunks.push(miniStreamData.subarray(off, off + miniSectorSize));
      s = miniFat[s];
    }
    let out = Buffer.concat(chunks);
    if (knownSize !== undefined && knownSize < out.length) out = out.subarray(0, knownSize);
    return out;
  }

  function readStreamData(entry) {
    if (entry.size < miniStreamCutoff) return followMiniChain(entry.startSector, entry.size);
    return followChain(entry.startSector, entry.size);
  }

  // 디렉터리는 평평한 배열이 아니라 트리(이진 트리형 형제 포인터) 구조 — 루트부터
  // 재귀적으로 훑어 "BodyText/Section0" 같은 전체 경로를 복원한다.
  const paths = {};
  function visit(nodeId, prefix) {
    if (nodeId >= 0xfffffffc) return;
    const e = entries[nodeId];
    if (!e) return;
    visit(e.leftSib, prefix);
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    paths[path] = e;
    if (e.type === 1 || e.type === 5) visit(e.childId, path); // storage(1) 또는 root(5)
    visit(e.rightSib, prefix);
  }
  visit(root.childId, "");

  return { paths, readStreamData };
}

const HWPTAG_PARA_TEXT = 0x43; // HWPTAG_BEGIN(0x10) + 51

// PARA_TEXT 레코드 데이터는 UTF-16LE 문자 시퀀스. 코드값 0~31은 표/그림 등 인라인
// 객체나 특수 글자를 뜻하며, 종류별로 추가로 건너뛸 길이가 다르다(HWP5 배포 문서 스펙).
function hwp5ControlCharExtraSkip(code) {
  if (code >= 1 && code <= 9) return code === 9 ? 0 : 7; // 1~8: 인라인 컨트롤(8워드 단위)
  if (code >= 11 && code <= 12) return 7;
  if (code >= 14 && code <= 17) return 7;
  if (code >= 18 && code <= 21) return 3;
  if (code === 22 || code === 23) return 7;
  return 0; // 0, 9(tab), 10(줄바꿈), 13(문단끝) 등은 추가 데이터 없음
}
function extractTextFromHwp5ParaText(data) {
  let out = "";
  for (let i = 0; i + 1 < data.length; i += 2) {
    const code = data.readUInt16LE(i);
    if (code === 0) continue;
    if (code < 32) {
      if (code === 9) out += "\t";
      if (code === 10 || code === 13) out += "\n";
      i += hwp5ControlCharExtraSkip(code) * 2;
      continue;
    }
    out += String.fromCharCode(code);
  }
  return out;
}
function parseHwp5Records(buf) {
  const records = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const header = buf.readUInt32LE(pos);
    const tagId = header & 0x3ff;
    let size = (header >>> 20) & 0xfff;
    pos += 4;
    if (size === 0xfff) {
      if (pos + 4 > buf.length) break;
      size = buf.readUInt32LE(pos);
      pos += 4;
    }
    if (pos + size > buf.length) break; // 손상/오독 방어 — 조용히 중단
    records.push({ tagId, data: buf.subarray(pos, pos + size) });
    pos += size;
  }
  return records;
}
function extractHwp5BodyText(fileBuf) {
  const cfbf = parseCFBF(fileBuf);
  if (!cfbf) return null;
  const { paths, readStreamData } = cfbf;
  const fileHeaderEntry = paths["FileHeader"];
  if (!fileHeaderEntry) return null;
  const fileHeader = readStreamData(fileHeaderEntry);
  if (fileHeader.subarray(0, 17).toString("latin1") !== "HWP Document File") return null; // HWP5 시그니처 확인
  const compressed = !!(fileHeader.readUInt32LE(36) & 1);

  const sectionPaths = Object.keys(paths)
    .filter((p) => /^BodyText\/Section\d+$/i.test(p))
    .sort((a, b) => {
      const na = +a.match(/\d+$/)[0];
      const nb = +b.match(/\d+$/)[0];
      return na - nb;
    });
  if (!sectionPaths.length) return null;

  const texts = [];
  for (const p of sectionPaths) {
    const raw = readStreamData(paths[p]);
    let sectionData;
    try {
      sectionData = compressed ? zlib.inflateRawSync(raw) : raw;
    } catch {
      continue; // 이 섹션만 건너뜀 — 전체를 실패로 처리하지 않음
    }
    const records = parseHwp5Records(sectionData);
    for (const r of records) {
      if (r.tagId === HWPTAG_PARA_TEXT) texts.push(extractTextFromHwp5ParaText(r.data));
    }
  }
  return texts.length ? texts.join("\n") : null;
}
async function fetchHwpText(url, { referer, cookie } = {}) {
  try {
    const headers = { "User-Agent": BROWSER_UA };
    if (referer) headers["Referer"] = referer;
    if (cookie) headers["Cookie"] = cookie;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 15 * 1024 * 1024) return null;
    return extractHwp5BodyText(buf);
  } catch {
    return null;
  }
}

async function fetchAttachmentPdfText(html, pageUrl) {
  let attachments = extractAttachmentPdfUrls(html, pageUrl);

  // 2026-10-22 발견: 그누보드5의 nonce는 그걸 발급한 "그 요청"의 세션 쿠키와만
  // 짝이 맞는다 — 서로 다른 요청(fetchText로 받은 html의 세션 vs 여기서 따로 받는
  // 쿠키의 세션)의 PHPSESSID가 서로 다르면 "잘못된 접근입니다" 오류만 돌아옴을
  // 실측으로 확인함. 그래서 hwp 첨부가 있을 때는, 쿠키와 nonce를 "같은 한 번의
  // 요청"에서 함께 다시 받아와 짝을 맞춘다(이미 넘어온 html은 이 용도로 쓰지 않음).
  if (attachments.some((a) => a.kind === "hwp")) {
    try {
      const fresh = await fetchTextWithCookie(pageUrl);
      const freshHwpUrls = extractAttachmentPdfUrls(fresh.text, pageUrl).filter((a) => a.kind === "hwp");
      let next = 0;
      attachments = attachments.map((a) =>
        a.kind === "hwp" && next < freshHwpUrls.length ? { ...freshHwpUrls[next++], _cookie: fresh.cookie } : a
      );
    } catch {
      /* 실패하면 원래 attachments로 계속 — 아래에서 쿠키 없이 시도해 보고 안 되면 null */
    }
  }

  const texts = [];
  for (const att of attachments) {
    let text = null;
    if (att.kind === "pdf") {
      text = await fetchPdfText(att.url);
    } else if (att.kind === "hwpx") {
      text = await fetchHwpxText(att.url);
    } else if (att.kind === "hwp") {
      text = await fetchHwpText(att.url, { referer: pageUrl, cookie: att._cookie || null });
    }
    if (text) texts.push(text);
    if (texts.join("\n").length > 8000) break; // 과도하게 긴 첨부파일은 앞부분만
  }
  return texts.length ? texts.join("\n").slice(0, 8000) : null;
}

async function fetchAndClassifyDetail(detailUrl, title, region, postedDate) {
  const result = {
    applyStart: null,
    applyEnd: null,
    applyLink: null,
    festivalStart: null,
    festivalEnd: null,
    venue: null,
    boothCount: null,
    fee: null,
    facilities: null,
    applyMethod: null,
    noticeType: "general",
    boothType: null,
    recruitStatus: "unknown",
    eligibility: null,
    ulsanEligible: "unknown",
    eligibilityCategory: "unknown",
    restrictedRegion: null,
    attachmentParsed: false,
    memo: "",
    linkStatus: "ok",
    linkCheckedAt: new Date().toISOString(),
    linkCheckDetail: null,
  };
  // 2026-10-22: 별도 신청 페이지 링크를 찾지 못하면 공식 공고 원문(detailUrl) 자체를
  // 신청 링크로 쓴다 — "링크 없음"으로 뜨는 대신 항상 누를 수 있는 링크를 보장하기 위함.
  result.applyLink = detailUrl;
  let rawHtml = "";
  let bodyText = "";
  let fetchFailNote = "";
  try {
    rawHtml = await fetchText(detailUrl);
    bodyText = stripHtml(rawHtml);
  } catch (err) {
    fetchFailNote = `상세페이지 접속 실패(${err.message}) — 본문은 확인 못 하고 제목만으로 분류함. `;
    const linkErr = classifyLinkError(err);
    result.linkStatus = linkErr.status;
    result.linkCheckDetail = linkErr.detail;
  }

  const cls = classifyNotice(title, bodyText);
  result.noticeType = cls.noticeType;
  result.boothType = cls.boothType;

  if (result.noticeType !== "recruit") {
    result.recruitStatus = "unknown";
    result.memo = `${fetchFailNote}${cls.reason}`;
    return result;
  }

  // 2026-10-21: "recruit"로 확정된 공고에 한해서만 첨부 PDF를 추가로 받아본다(모든 공고에
  // 다 시도하면 불필요한 네트워크 호출이 늘어나므로, 실제로 검토 대상인 것만). 본문과
  // PDF 텍스트를 합쳐서 하나의 텍스트로 모든 필드를 추출 — PDF만 있거나 본문만 있어도
  // 전부 커버됨. PDF 다운로드/파싱이 실패해도 본문 분석 결과는 그대로 유지(안전한 폴백).
  let pdfText = null;
  if (rawHtml) {
    pdfText = await fetchAttachmentPdfText(rawHtml, detailUrl);
    result.attachmentParsed = !!pdfText;
  }
  const combinedText = pdfText ? `${bodyText}\n${pdfText}` : bodyText;
  // 행사명/장소/모집규모/참가비/신청방법처럼 "한 줄에 한 항목"인 라벨은 줄바꿈이 살아있는
  // 버전으로 뽑아야 값이 다음 항목까지 삼켜지지 않는다(위 stripHtmlPreserveLines 참고).
  const lineAwareBody = rawHtml ? stripHtmlPreserveLines(rawHtml) : bodyText;
  const lineAwareText = pdfText ? `${lineAwareBody}\n${pdfText}` : lineAwareBody;

  const dateInfo = extractDateRange(combinedText, postedDate || null);
  result.applyStart = dateInfo.applyStart;
  result.applyEnd = dateInfo.applyEnd;
  result.recruitStatus = dateInfo.recruitStatus;

  const eventPeriod = extractEventPeriod(lineAwareText);
  result.festivalStart = eventPeriod.festivalStart;
  result.festivalEnd = eventPeriod.festivalEnd;

  result.venue = extractVenue(lineAwareText);
  result.boothCount = extractBoothCount(lineAwareText);
  result.fee = extractFee(lineAwareText);
  result.facilities = extractFacilities(lineAwareText);
  result.applyMethod = extractApplyMethod(lineAwareText);
  result.applyLink = extractApplyLink(combinedText) || result.applyLink;

  const eligInfo = detectEligibility(combinedText, region);
  result.eligibility = eligInfo.eligibility;
  result.ulsanEligible = eligInfo.ulsanEligible;
  result.eligibilityCategory = eligInfo.eligibilityCategory;
  result.restrictedRegion = eligInfo.restrictedRegion;

  const attachments = [...bodyText.matchAll(ATTACHMENT_RE)].map((m) => m[1]);
  const eligNote = eligInfo.eligibility
    ? ` 참가자격 근거: "${eligInfo.eligibility}"${eligInfo.restrictedRegion ? ` (제한 지역: ${eligInfo.restrictedRegion})` : ""}.`
    : "";
  const pdfNote = result.attachmentParsed
    ? " 첨부 PDF·HWPX·HWP 공고문에서 세부정보를 추가로 확인함."
    : attachments.length
      ? ` 첨부파일(${attachments.join(", ")})이 있으나 자동분석에 실패했거나 지원하지 않는 형식(이미지 등)이라 직접 확인이 필요함.`
      : "";
  if (result.recruitStatus === "unknown") {
    result.memo = `${fetchFailNote}${cls.reason} 모집기간을 확인하지 못함 — 원문을 직접 확인하세요.${eligNote}${pdfNote}`;
  } else {
    const periodText = result.applyStart ? `${result.applyStart}~${result.applyEnd}` : `~${result.applyEnd}(시작일 미확인)`;
    result.memo = `${cls.reason} 모집기간(${periodText}) 확인됨.${eligNote}${pdfNote}`;
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
    .replace(/&#039;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// 2026-10-16 추가: 울산·밀양·창원 기관에서 GitHub Actions 쪽 네트워크가 일시적으로
// "fetch failed"(연결 자체 실패)를 뱉는 사례가 반복 관측됨 — 같은 코드로 몇 분 뒤
// 재실행하면 정상 복구되는 걸 확인했었음(일시적 장애, 코드/URL 문제 아님). 그래서 모든
// fetchText() 호출(게시판 목록 + 글 상세페이지 전부 이 함수를 통하므로 한 곳만 고치면
// 전체 적용됨)에 "최초 시도 포함 총 3회(최초 1회 + 재시도 2회), 3초 간격" 재시도를 추가.
// 재시도마다 실패 원인(err.message + err.cause, 있으면)을 즉시 콘솔에 남겨 다음에
// FETCH FAILED가 또 나오면 DNS/타임아웃/HTTP 에러 중 무엇이었는지 바로 구분할 수 있게 함.
const FETCH_MAX_RETRIES = 2;
const FETCH_RETRY_DELAY_MS = 3000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeFetchError(err) {
  const cause = err && err.cause ? (err.cause.code || err.cause.message || String(err.cause)) : null;
  return cause ? `${err.message} (원인: ${cause})` : err.message;
}

// 2026-10-17 추가: 공식 신청 링크(원문 URL) 접속 오류를 "일시적 네트워크 문제"와
// "실제로 깨진 링크(HTTPS 인증서 오류 등 — 브라우저에서도 똑같이 막힘)"로 구분하기
// 위한 분류. 사용자가 실제로 ulsanwhale.com에서 NET::ERR_CERT_COMMON_NAME_INVALID를
// 겪은 사례처럼, 인증서 오류는 재시도해도 해결되지 않고 모든 방문자에게 동일하게
// 발생하므로 "linkStatus: needs_review"로 표시해 사람이 확인하게 한다. 링크 자체를
// 임의로 지우거나 바꾸지는 않는다(이 함수는 상태만 분류함).
const CERT_ERROR_CODES = [
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "CERT_UNTRUSTED",
  "ERR_TLS_CERT_ALTNAME_FORMAT",
  "HOSTNAME_MISMATCH",
  "ERR_SSL_WRONG_VERSION_NUMBER",
];
function classifyLinkError(err) {
  const cause = err && err.cause ? err.cause : null;
  const code = cause && cause.code ? cause.code : null;
  const message = describeFetchError(err);
  const isCert = (code && CERT_ERROR_CODES.includes(code)) || /certificate|SSL|TLS/i.test(message);
  // fetchText()가 이미 3회(최초 1회 + 재시도 2회) 시도한 뒤에만 여기로 오므로, 단순 일시적
  // 네트워크 지연일 가능성은 낮다고 보고 인증서 오류든 아니든 동일하게 "needs_review"로
  // 둔다 — detail에 원인(인증서 문제인지 등)을 남겨 사람이 구분해서 볼 수 있게 한다.
  return { status: "needs_review", detail: isCert ? `[인증서 오류] ${message}` : message };
}

// 2026-10-18: 전국 34개 기관으로 늘어난 뒤, 응답을 아예 안 보내고 연결만 붙잡고 있는
// 사이트 하나 때문에 전체 수집이 통째로 멈추는(무한 대기) 사고를 실제로 겪었음 — fetch()에
// 기본 타임아웃이 없어서 생긴 문제. AbortSignal.timeout으로 요청당 최대 대기 시간을 둬서
// 이런 사이트 하나가 전체 파이프라인을 막지 못하게 함(재시도 로직과는 별개 — 타임아웃도
// 똑같이 FETCH_MAX_RETRIES만큼 재시도됨).
const FETCH_TIMEOUT_MS = 20000;
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// 2026-10-19: 함안군청 등 일부 사이트가 HTTP 응답 헤더에 HTTP/1.1 스펙에 어긋나는 값(예:
// 헤더값에 들어있으면 안 되는 제어문자)을 그대로 보내는 걸 실측으로 확인 — Node의 기본
// fetch(undici)는 이를 엄격하게 거부해 "Response does not match the HTTP/1.1 protocol
// (Invalid header value char)" 에러로 요청 자체가 실패한다. 브라우저는 이런 응답도 그냥
// 보여주므로(실제로 접속은 된다는 뜻) 실제 접속 불가가 아니라 Node 쪽 파싱이 과하게
// 엄격한 것 — node:https를 insecureHTTPParser 옵션으로 직접 호출해 우회한다(인증서 검증은
// 그대로 유지되고, 느슨해지는 건 헤더 파싱 엄격도뿐).
const MALFORMED_HEADER_RE = /does not match the HTTP\/1\.1 protocol|Parse Error|invalid header/i;

function fetchTextLenient(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("http://") ? require("http") : require("https");
    const req = mod.get(
      url,
      { headers: { "User-Agent": BROWSER_UA }, insecureHTTPParser: true, timeout: FETCH_TIMEOUT_MS },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      }
    );
    req.on("timeout", () => req.destroy(new Error("lenient fetch timeout")));
    req.on("error", reject);
  });
}

async function fetchText(url) {
  let lastErr;
  for (let attempt = 1; attempt <= FETCH_MAX_RETRIES + 1; attempt++) {
    try {
      const res = await fetch(url, {
        // 2026-10-18: 전국 확대 과정에서 사천·함안·창녕·함양시청 등 일부 기관이 이
        // 식별용 User-Agent를 WAF로 차단(HTTP 400 "Request Blocked")하는 것을 실측으로
        // 확인 — 일반 브라우저 UA로 바꿔서 해결(기존에 정상 응답하던 기관들에는 영향 없음,
        // 더 흔한 UA로 바뀌는 것뿐이라 차단 가능성은 오히려 낮아짐).
        headers: { "User-Agent": BROWSER_UA },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      if (MALFORMED_HEADER_RE.test(describeFetchError(err))) {
        try {
          return await fetchTextLenient(url);
        } catch (lenientErr) {
          lastErr = lenientErr;
        }
      } else {
        lastErr = err;
      }
      const isLast = attempt === FETCH_MAX_RETRIES + 1;
      console.log(
        `  [fetch 실패 ${attempt}/${FETCH_MAX_RETRIES + 1}] ${url} — ${describeFetchError(lastErr)}` +
          (isLast ? " — 재시도 소진, 이 요청은 포기" : ` — ${FETCH_RETRY_DELAY_MS / 1000}초 후 재시도`)
      );
      if (!isLast) await sleep(FETCH_RETRY_DELAY_MS);
    }
  }
  throw lastErr;
}

// Generic anchor extractor: works across differing board markups without
// needing a bespoke <tr> regex per site.
const ANCHOR_RE = /<a\s+[^>]*href="([^"#][^"]*)"[^>]*>([\s\S]{1,200}?)<\/a>/g;

// 2026-10-24 수정: 울산 사이트들의 게시판 목록 페이지에는 사이트 공통 좌측/상단
// 메뉴 전체가 같은 HTML에 통째로 포함돼 있고, 그 메뉴 항목 중 "나눔장터"(북구청 —
// 분리수거 교환장터 서비스 소개 메뉴), "축제/행사"(중구청 — 카테고리 메뉴 라벨)처럼
// KEYWORD_RE에 걸리는 글자가 실제로 있음을 실측으로 확인함. 이런 메뉴 항목은 각
// 사이트마다 고유한 메뉴 전용 URL 패턴("/lay1/.../sublink.do", "index.ulsan?menuCd=")을
// 쓰고, 실제 게시글은 전부 "bbs/.../view.do?article_seq="나 "board/view.ulsan?..."
// 형태라 겹치지 않는다(기존 166건 전수 확인 — 이 두 패턴을 쓰는 레코드는 이 오탐
// 2건뿐이었음). 그래서 메뉴 전용 URL은 게시글 후보에서 원천적으로 제외한다.
const MENU_LINK_RE = /\/sublink\.do(?:[?#]|$)|[?&]menuCd=[^&]*$/;

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
    if (MENU_LINK_RE.test(absUrl)) continue;
    out.push({ title: text, url: absUrl });
  }
  return out;
}

// 2026-10-17: 같은 글이 리스트 페이지 번호가 바뀌거나(밀양 pageIndex 사례) 검색
// 키워드가 달라져서 다른 URL로 다시 수집되는 걸 막기 위한 공용 중복 방지 키.
// seen.json은 "전체 URL"을 키로 쓰지만, 그와 별도로 "진짜 글 식별자"(idx,
// parm_bod_uid, nttId 등 게시판마다 쓰는 고유번호 파라미터)만 뽑아 비교하는 보조
// 인덱스를 같이 두고, 기존에 이미 수집된 seen.json 전체에서도 미리 만들어 둔다 —
// 이러면 과거에 다른 페이지 번호로 저장된 글도 오늘 다른 URL로 다시 안 잡힌다.
// 이전엔 확장 보드(경주/김해 등)에서만 이번 실행 한정으로 썼는데, 이번에 울산
// 보드까지 포함해 seen.json 전체 기준으로 범위를 넓혔다.
// 2026-10-22: main() 바깥 모듈 스코프로 옮겨 module.exports로 테스트 가능하게 함
// (동작은 그대로, require()해서 단독으로 검증할 수 있게 하기 위함).
function canonicalDedupKey(urlStr) {
  try {
    const u = new URL(urlStr);
    const idParam = ["idx", "parm_bod_uid", "nttId", "bIdx", "article_seq", "dataId"]
      .map((k) => u.searchParams.get(k))
      .find((v) => v);
    return idParam ? `${u.origin}${u.pathname}|${idParam}` : `${u.origin}${u.pathname}${u.search}`;
  } catch {
    return urlStr;
  }
}

// 2026-10-22 신설: 같은 글이 서로 다른 URL(파라미터만 다름)로 두 번 등록된 경우를
// 최종 저장 직전에 한 번 더 정리한다. seen.json 기반 사전 차단이 이미 있지만, 과거에
// seen.json이 아직 커밋되기 전에 수동으로 두 번 실행했을 때 실제로 뚫린 사례가
// 있었다(2026-10-15, 김해 단감축제 체험부스 모집 공고가 idx=21과
// idx=21&cpage=1&gcode=1002 두 URL로 중복 등록됨) — 그래서 canonicalDedupKey가 같은
// 항목들을 최종적으로 한 번 더 모아 하나만 남긴다. 사람이 이미 승인/거절한 항목이
// 있으면 그 결정을 보존하고(approved/rejected가 섞여 있으면 먼저 수집된 쪽을 기준),
// 전부 pending이면 그중 가장 먼저 수집된 것만 남긴다.
// 데이터를 지우거나 status를 바꾸지 않고 "중복 표시"만 한다 — 전체 건수와 각 항목의
// 승인 상태를 그대로 보존해야 하므로(요청사항), 같은 글의 나머지 항목을 배열에서
// 빼거나 status를 내리는 대신 duplicateOf 필드에 대표 항목의 id만 추가로 적어둔다.
// 홈페이지(web/index.html)는 이 필드가 있는 항목을 공개 목록에서만 건너뛴다 — 데이터
// 자체(건수·status)는 전혀 건드리지 않는다(2026-10-22, "데이터 삭제·초기화 금지"와
// "승인 건수 보존" 요청에 맞춰 삭제/status변경 방식에서 다시 변경).
function dedupeByCanonicalUrl(items) {
  const groups = new Map();
  for (const item of items) {
    const key = canonicalDedupKey(item.sourceUrl);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const out = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      out.push(group[0]);
      continue;
    }
    const sorted = [...group].sort((a, b) => new Date(a.collectedAt) - new Date(b.collectedAt));
    // 이미 승인된 게 있으면 그 결정을 대표로 삼고, 전부 미승인이면 가장 먼저 수집된
    // 것을 대표로 삼는다.
    const canonical = sorted.find((i) => i.status === "approved") || sorted[0];
    for (const item of group) {
      if (item.id === canonical.id || item.duplicateOf) {
        out.push(item); // 대표 항목이거나 이미 중복 표시된 항목 — 그대로 둠.
        continue;
      }
      out.push({ ...item, duplicateOf: canonical.id });
    }
  }
  return out;
}

// 2026-10-24 신설(요청사항): "울산 북구 관련 수집 경로만 우선 실행" — 기본 동작(cron 일정,
// 전체 지역 수집)은 그대로 두고, COLLECT_SCOPE=bukgu 환경변수가 설정됐을 때만 북구 관련
// 게시판(북구청 3종 + 북구 eminwon + 쇠부리축제)만 돌리는 opt-in 모드를 추가한다. 다른
// 지역의 코드·데이터는 전혀 건드리지 않음 — workflow_dispatch 수동 실행에서만 켤 수 있고,
// 매일 자동 실행(cron)은 기존처럼 전체 지역을 그대로 수집한다.
const BUKGU_ONLY = process.env.COLLECT_SCOPE === "bukgu";
function isBukguRelatedBoard(board) {
  return board.city === "북구" || /북구|쇠부리/.test(board.org);
}

async function main() {
  if (BUKGU_ONLY) {
    console.log("=== COLLECT_SCOPE=bukgu — 울산 북구 관련 게시판만 수집합니다 ===\n");
  }

  const seen = fs.existsSync(SEEN_PATH) ? JSON.parse(fs.readFileSync(SEEN_PATH, "utf8")) : {};
  const existingCollected = fs.existsSync(OUT_PATH) ? JSON.parse(fs.readFileSync(OUT_PATH, "utf8")) : [];
  const stillPendingUrls = new Set(existingCollected.map((i) => i.url));

  const seenCanonical = new Set(Object.keys(seen).map(canonicalDedupKey));

  const newItems = [];
  const perBoardCounts = [];
  let schoolExcludedTotal = 0;

  // 2026-10-19: "실제 수집에 성공한 기관과 실패한 기관을 구분"하기 위한 기관(org) 단위
  // 집계. 같은 기관이 게시판 여러 개(북구청 3개, 울주군청 키워드별 7개 등)로 등록돼 있으니
  // 기관명으로 묶어서, 그중 하나라도 fetch에 성공하면 그 기관은 "ok"로 본다 — 사람이 볼 땐
  // "울주군청이 수집 중이냐"가 궁금한 거지 "울주군청 검색어 3번째 게시판이냐"가 아니기 때문.
  // 전부 실패한 기관만 "fetch_failed"로 남겨 홈페이지에서 바로 구분할 수 있게 한다.
  const orgStatus = new Map();
  function recordBoardResult(board, ok, detail) {
    const key = board.org;
    const prev = orgStatus.get(key) || {
      org: board.org,
      region: board.region || "울산",
      boards: 0,
      okBoards: 0,
      failedBoards: 0,
      lastError: null,
    };
    prev.boards += 1;
    if (ok) {
      prev.okBoards += 1;
    } else {
      prev.failedBoards += 1;
      prev.lastError = detail;
    }
    orgStatus.set(key, prev);
  }

  for (const board of BOARDS.filter((b) => !BUKGU_ONLY || isBukguRelatedBoard(b))) {
    try {
      const html = await fetchText(board.url);
      const candidates = extractCandidates(html, board.url);
      recordBoardResult(board, true);

      // 2026-10-24 신설: "매칭 N건"만으론 그중 몇 건이 실제로 새로 저장됐고 몇 건이
      // 이미 수집된 글(중복)이라 건너뛰었는지 로그에서 알 수 없었음(요청사항 — GitHub
      // Actions 로그에서 신규/중복/실패를 구분할 수 있게 개선). 보드 1개 처리가 끝난
      // 뒤 한 줄로 합쳐서 출력한다.
      let newCount = 0;
      let dupCount = 0;
      let invalidCount = 0;
      let schoolCount = 0;
      for (const c of candidates) {
        // 2026-10-23 신설: "javascript:;" 같은 실행 불가 href가 그대로 섞여 들어오는
        // 경우(실측 — 울주군청 통합검색 페이지의 "실시간 인기검색어" 위젯이 검색결과
        // 목록처럼 보이는 <a href="javascript:;">를 내보냄)를 걸러낸다. 이런 후보는
        // 원문 URL이 영원히 없는 "확인 불가" 데이터만 쌓이게 되므로, seen 등록 전에
        // 미리 제외해 깨진 레코드가 생기지 않게 한다.
        if (!/^https?:\/\//i.test(c.url)) {
          invalidCount++;
          continue;
        }
        if (SCHOOL_EXCLUDE_RE.test(c.title)) {
          schoolCount++;
          schoolExcludedTotal++;
          continue; // 요청사항 — 학교 주관/대상 모집공고는 수집 대상에서 제외
        }
        if (seen[c.url]) {
          dupCount++;
          continue; // already surfaced in a past run
        }
        const ckey = canonicalDedupKey(c.url);
        if (seenCanonical.has(ckey)) {
          dupCount++;
          continue; // 같은 글이 다른 페이지/파라미터로 재수집되는 것 방지
        }
        seenCanonical.add(ckey);
        seen[c.url] = { firstSeen: new Date().toISOString(), org: board.org };
        newCount++;

        // 2026-10-16: 경주·김해·밀양과 동일한 기준(classifyNotice)을 울산 보드에도 적용해
        // 판매부스·체험부스·프리마켓 등 실제 부스 모집만 noticeType="recruit"(우선 검토)로
        // 남기고, 축제 개최/종료 소식이나 교육·자원봉사 등 부스 무관 모집은 "general"로,
        // 제목만으로 애매하면 "review"로 구분한다. (분류 정확도 개선 요청에 따른 변경)
        const cls = await fetchAndClassifyDetail(c.url, c.title, "울산", null);
        newItems.push({
          // sha256 of the full URL, not a truncated base64 of it — URLs from the
          // same board share a long prefix, so slicing plain base64 collided across
          // different articles (fixed 2026-10-05).
          id: `gh-${require("crypto").createHash("sha256").update(c.url).digest("base64url").slice(0, 16)}`,
          name: c.title,
          region: "울산",
          city: board.city || null,
          eventCity: extractEventCity(cls.venue),
          sourceOrg: board.sourceOrg,
          sourceUrl: c.url,
          applyStart: cls.applyStart,
          applyEnd: cls.applyEnd,
          festivalStart: cls.festivalStart,
          festivalEnd: cls.festivalEnd,
          applyLink: cls.applyLink,
          venue: cls.venue,
          boothCount: cls.boothCount,
          fee: cls.fee,
          facilities: cls.facilities,
          applyMethod: cls.applyMethod,
          boothType: cls.boothType,
          eligibility: cls.eligibility,
          ulsanEligible: cls.ulsanEligible,
          eligibilityCategory: cls.eligibilityCategory,
          restrictedRegion: cls.restrictedRegion,
          attachmentParsed: cls.attachmentParsed,
          linkStatus: cls.linkStatus,
          linkCheckedAt: cls.linkCheckedAt,
          linkCheckDetail: cls.linkCheckDetail,
          collectedAt: new Date().toISOString(),
          status: decideAutoPublishStatus(cls),
          organizerType: "official",
          noticeType: cls.noticeType,
          recruitStatus: cls.recruitStatus,
          memo: `자동수집(GitHub Actions, ${board.org}). ${cls.memo}`,
        });
      }
      perBoardCounts.push(
        `${board.sourceOrg}: ${candidates.length}건 매칭 (원본 앵커 ${(html.match(/<a\s/g) || []).length}개 중) → 신규 ${newCount}건, 중복 ${dupCount}건${invalidCount ? `, 무효링크 ${invalidCount}건` : ""}${schoolCount ? `, 학교제외 ${schoolCount}건` : ""}`
      );
    } catch (err) {
      perBoardCounts.push(`${board.sourceOrg}: FETCH FAILED (재시도 ${FETCH_MAX_RETRIES}회 모두 실패) — ${describeFetchError(err)}`);
      recordBoardResult(board, false, describeFetchError(err));
    }
  }

  // ---- 경주·김해·밀양·영주·경산·창원·하동 확대분: 실제 모집 여부까지 분류해서 기록 ----
  // 사이트마다 목록 마크업이 달라 전용 추출기를 쓰는 곳이 있다(밀양/영주·경산/창원) — 그 외
  // 흐름(상세페이지 분류, dedup, 데이터 저장)은 전부 동일하게 재사용한다.
  for (const board of [
    ...BUKGU_FESTIVAL_BOARDS,
    ...GYEONGJU_GIMHAE_BOARDS,
    ...MIRYANG_BOARDS,
    ...YEONGJU_GYEONGSAN_BOARDS,
    ...CHANGWON_BOARDS,
    ...HADONG_BOARDS,
    ...NATIONWIDE_PHASE1_BOARDS,
    ...NATIONWIDE_PHASE2_BOARDS,
    ...NATIONWIDE_PHASE3_BOARDS,
    ...NATIONWIDE_PHASE4_BOARDS,
    ...NATIONWIDE_PHASE5_BOARDS,
    ...NATIONWIDE_PHASE6_BOARDS,
    ...NATIONWIDE_PHASE7_BOARDS,
    ...NATIONWIDE_PHASE8_BOARDS,
    ...NATIONWIDE_PHASE9_BOARDS,
    ...NATIONWIDE_PHASE10_BOARDS,
  ].filter((b) => !BUKGU_ONLY || isBukguRelatedBoard(b))) {
    try {
      const html = await fetchText(board.url);
      const extractFn = board.extractor || ((h, u) => extractPostCandidates(h, u, NEW_SITE_KEYWORD_RE));
      const candidates = extractFn(html, board.url);
      perBoardCounts.push(`${board.sourceOrg}: ${candidates.length}건 매칭 (원본 앵커 ${(html.match(/<a\s/g) || []).length}개 중)`);
      recordBoardResult(board, true);

      for (const c of candidates) {
        if (SCHOOL_EXCLUDE_RE.test(c.title)) {
          schoolExcludedTotal++;
          continue; // 요청사항 — 학교 주관/대상 모집공고는 수집 대상에서 제외
        }
        if (seen[c.url]) continue;
        const ckey = canonicalDedupKey(c.url);
        if (seenCanonical.has(ckey)) continue;
        seenCanonical.add(ckey);
        seen[c.url] = { firstSeen: new Date().toISOString(), org: board.org };

        const cls = await fetchAndClassifyDetail(c.url, c.title, board.region, c.postedDate || null);
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
          festivalStart: cls.festivalStart,
          festivalEnd: cls.festivalEnd,
          applyLink: cls.applyLink,
          venue: cls.venue,
          boothCount: cls.boothCount,
          fee: cls.fee,
          facilities: cls.facilities,
          applyMethod: cls.applyMethod,
          boothType: cls.boothType,
          eligibility: cls.eligibility,
          ulsanEligible: cls.ulsanEligible,
          eligibilityCategory: cls.eligibilityCategory,
          restrictedRegion: cls.restrictedRegion,
          attachmentParsed: cls.attachmentParsed,
          linkStatus: cls.linkStatus,
          linkCheckedAt: cls.linkCheckedAt,
          linkCheckDetail: cls.linkCheckDetail,
          collectedAt: new Date().toISOString(),
          status: decideAutoPublishStatus(cls),
          organizerType: "official",
          noticeType: cls.noticeType,
          recruitStatus: cls.recruitStatus,
          memo: `자동수집(GitHub Actions, ${board.org} — 검증된 공식 URL). ${cls.memo}`,
        });
      }
    } catch (err) {
      perBoardCounts.push(`${board.sourceOrg}: FETCH FAILED (재시도 ${FETCH_MAX_RETRIES}회 모두 실패) — ${describeFetchError(err)}`);
      recordBoardResult(board, false, describeFetchError(err));
    }
  }

  // ---- 북구청·동구청·남구청 eminwon 고시공고: 목록 발견은 Playwright, 그 다음은
  // 전부 기존 순수 HTTP 분류/첨부파일 로직 재사용(collect-playwright.js 상단 주석 참고).
  // Playwright/크로미움이 설치 안 된 환경에서도 이 기관들만 fetch_failed로 분리되고
  // 나머지 수집은 그대로 진행되도록 기관별 try/catch로 감싼다.
  for (const board of EMINWON_PLAYWRIGHT_BOARDS.filter((b) => !BUKGU_ONLY || isBukguRelatedBoard(b))) {
    try {
      const candidates = await fetchEminwonCandidates(board.listUrl, NEW_SITE_KEYWORD_RE, NOISE_RE);
      recordBoardResult(board, true);

      // 2026-10-24 신설: 다른 두 반복문과 동일하게 신규/중복 건수를 구분해 로그에 남김.
      let newCount = 0;
      let dupCount = 0;
      for (const c of candidates) {
        if (SCHOOL_EXCLUDE_RE.test(c.title)) {
          schoolExcludedTotal++;
          continue; // 요청사항 — 학교 주관/대상 모집공고는 수집 대상에서 제외
        }
        const detailUrl = buildEminwonDetailUrl(board.host, c.id);
        if (seen[detailUrl]) {
          dupCount++;
          continue;
        }
        const ckey = canonicalDedupKey(detailUrl);
        if (seenCanonical.has(ckey)) {
          dupCount++;
          continue;
        }
        seenCanonical.add(ckey);
        seen[detailUrl] = { firstSeen: new Date().toISOString(), org: board.org };
        newCount++;

        // 2026-10-23 신설: 목록 화면 제목이 길면 "..."로 잘려 있어(실측: 북구청
        // id=45135) 상세페이지를 한 번 더 받아 전체 제목으로 보정한다. 보정에
        // 실패해도(네트워크 오류 등) 목록 제목으로 계속 진행 — 전체 수집을 막지 않음.
        let title = c.title;
        try {
          const detailHtmlForTitle = await fetchText(detailUrl);
          const fullTitle = extractEminwonDetailTitle(detailHtmlForTitle);
          if (fullTitle) title = fullTitle;
        } catch {
          /* 보정 실패 — 목록 제목 그대로 사용 */
        }

        const cls = await fetchAndClassifyDetail(detailUrl, title, board.region, null);
        newItems.push({
          id: `gh-${require("crypto").createHash("sha256").update(detailUrl).digest("base64url").slice(0, 16)}`,
          name: title,
          region: board.region,
          city: board.city || null,
          eventCity: extractEventCity(cls.venue),
          sourceOrg: board.sourceOrg,
          sourceUrl: detailUrl,
          applyStart: cls.applyStart,
          applyEnd: cls.applyEnd,
          festivalStart: cls.festivalStart,
          festivalEnd: cls.festivalEnd,
          applyLink: cls.applyLink,
          venue: cls.venue,
          boothCount: cls.boothCount,
          fee: cls.fee,
          facilities: cls.facilities,
          applyMethod: cls.applyMethod,
          boothType: cls.boothType,
          eligibility: cls.eligibility,
          ulsanEligible: cls.ulsanEligible,
          eligibilityCategory: cls.eligibilityCategory,
          restrictedRegion: cls.restrictedRegion,
          attachmentParsed: cls.attachmentParsed,
          linkStatus: cls.linkStatus,
          linkCheckedAt: cls.linkCheckedAt,
          linkCheckDetail: cls.linkCheckDetail,
          collectedAt: new Date().toISOString(),
          status: decideAutoPublishStatus(cls),
          organizerType: "official",
          noticeType: cls.noticeType,
          recruitStatus: cls.recruitStatus,
          memo: `자동수집(GitHub Actions, ${board.org} — 헤드리스 브라우저로 목록 발견). ${cls.memo}`,
        });
      }
      perBoardCounts.push(
        `${board.sourceOrg}: ${candidates.length}건 매칭 (헤드리스 브라우저로 목록 발견) → 신규 ${newCount}건, 중복 ${dupCount}건`
      );
    } catch (err) {
      perBoardCounts.push(`${board.sourceOrg}: FETCH FAILED (헤드리스 브라우저 목록 발견 실패) — ${describeFetchError(err)}`);
      recordBoardResult(board, false, describeFetchError(err));
    }
  }

  // Prune anything older than 45 days from the public feed — by then it's
  // either been reviewed (localStorage on the reviewer's own browser) or
  // stale enough not to matter. seen.json still remembers the URL forever,
  // so a pruned item never resurfaces as "new".
  const PRUNE_MS = 45 * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - PRUNE_MS;
  const merged = dedupeByCanonicalUrl(
    [...existingCollected, ...newItems].filter((i) => new Date(i.collectedAt).getTime() >= cutoff)
  );

  // 기관 목록을 지역별로 보기 좋게 정렬 — 실패(ok=false)부터, 그다음 지역명 순.
  const boardStatusList = [...orgStatus.values()]
    .map((o) => ({
      org: o.org,
      region: o.region,
      status: o.okBoards > 0 ? "ok" : "fetch_failed",
      boards: o.boards,
      okBoards: o.okBoards,
      failedBoards: o.failedBoards,
      lastError: o.okBoards > 0 ? null : o.lastError,
      checkedAt: new Date().toISOString(),
    }))
    .sort((a, b) => (a.status === b.status ? a.region.localeCompare(b.region, "ko") : a.status === "fetch_failed" ? -1 : 1));

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SEEN_PATH, JSON.stringify(seen, null, 2));
  fs.writeFileSync(OUT_PATH, JSON.stringify(merged, null, 2));
  fs.writeFileSync(BOARD_STATUS_PATH, JSON.stringify(boardStatusList, null, 2));

  // 2026-10-24 신설(요청사항): "수집 성공, 실패, 신규 공고 건수를 각각 구분해서 로그에
  // 표시" — 아래에 이미 기관별/보드별 상세 로그가 있지만, 한눈에 성공·실패·신규만 보고
  // 싶을 때를 위해 맨 위에 요약 한 줄을 둔다.
  const okOrgCountEarly = [...orgStatus.values()].filter((o) => o.okBoards > 0).length;
  const failedOrgCountEarly = [...orgStatus.values()].filter((o) => o.okBoards === 0).length;
  console.log("=== 전체 요약 ===");
  console.log(
    `성공 ${okOrgCountEarly}개 기관, 실패 ${failedOrgCountEarly}개 기관, 신규 공고 ${newItems.length}건` +
      (schoolExcludedTotal ? `, 학교 제외 ${schoolExcludedTotal}건` : "")
  );

  console.log("\n=== 게시판별 결과 ===");
  perBoardCounts.forEach((l) => console.log(l));

  // 2026-10-24 신설: "북구청 3종 + eminwon(북구·동구·남구) 3종"의 성공/신규/중복/실패를
  // 한눈에 볼 수 있게 별도로 모아서 출력(요청사항 — GitHub Actions 로그 가독성 개선).
  // perBoardCounts에 이미 있는 줄들을 그대로 다시 쓰는 것이라 집계 로직은 중복되지 않음.
  const bukguRelatedCounts = perBoardCounts.filter((l) => /^(북구청|동구청|남구청)/.test(l));
  if (bukguRelatedCounts.length) {
    console.log("\n=== 울산 북구청 3종 + eminwon(북구·동구·남구) 요약 ===");
    bukguRelatedCounts.forEach((l) => console.log(l));
  }

  console.log(`\n신규 발견: ${newItems.length}건`);
  newItems.forEach((i) => console.log(` - [${i.sourceOrg}] ${i.name} -> ${i.sourceUrl}`));
  console.log(`\n누적 pending 총 ${merged.length}건 (data/collected.json)`);
  const failedOrgs = boardStatusList.filter((o) => o.status === "fetch_failed");
  console.log(`\n=== 기관별 수집 상태 (${boardStatusList.length}개 기관, 실패 ${failedOrgs.length}개) ===`);
  if (failedOrgs.length > 0) {
    failedOrgs.forEach((o) => console.log(` - [실패] ${o.region} ${o.org}: ${o.lastError}`));
  }
}

// 2026-10-21: require.main 가드를 추가해 "node scripts/collect.js"로 직접 실행할 때의
// 동작(GitHub Actions 포함)은 그대로 두고, 테스트 스크립트에서 require()로 불러와
// fetchAndClassifyDetail() 등 개별 함수만 검증할 수 있게 함(검증 후 수동 실행 없이
// require만 해도 전체 수집이 돌아가지 않게 하려는 목적 — 실제 동작은 변경 없음).
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

// 2026-10-22 신설: main() 안에서만 쓰던 보드 목록 전체를 외부에서도 점검할 수 있게
// 하나로 모아 내보낸다(동작 변경 없음 — main()의 두 반복문이 쓰는 것과 동일한 배열).
// "60개 기관 전수 점검" 같은 진단 스크립트가 이 목록을 그대로 재사용해, main()의
// 실제 수집 로직과 분리된 별도 URL 목록을 만들다가 서로 어긋나는 일을 막기 위함.
const ALL_BOARDS = [
  // isUlsanBaseBoard: main()의 첫 반복문(BOARDS, extractCandidates 사용)과 둘째 반복문
  // (아래 나머지 전부, board.extractor || extractPostCandidates 사용)이 서로 다른
  // 추출기를 쓰므로, 외부 점검 스크립트가 어느 쪽을 써야 하는지 구분할 수 있게 표시.
  ...BOARDS.map((b) => ({ ...b, region: b.region || "울산", isUlsanBaseBoard: true })),
  ...BUKGU_FESTIVAL_BOARDS,
  ...GYEONGJU_GIMHAE_BOARDS,
  ...MIRYANG_BOARDS,
  ...YEONGJU_GYEONGSAN_BOARDS,
  ...CHANGWON_BOARDS,
  ...HADONG_BOARDS,
  ...NATIONWIDE_PHASE1_BOARDS,
  ...NATIONWIDE_PHASE2_BOARDS,
  ...NATIONWIDE_PHASE3_BOARDS,
  ...NATIONWIDE_PHASE4_BOARDS,
  ...NATIONWIDE_PHASE5_BOARDS,
  ...NATIONWIDE_PHASE6_BOARDS,
  ...NATIONWIDE_PHASE7_BOARDS,
  ...NATIONWIDE_PHASE8_BOARDS,
  ...NATIONWIDE_PHASE9_BOARDS,
  ...NATIONWIDE_PHASE10_BOARDS,
];

module.exports = {
  ALL_BOARDS,
  extractCandidates,
  extractPostCandidates,
  NEW_SITE_KEYWORD_RE,
  describeFetchError,
  fetchAndClassifyDetail,
  extractDateRange,
  extractEventPeriod,
  detectEligibility,
  extractVenue,
  extractEventCity,
  extractBoothCount,
  extractFee,
  extractFacilities,
  extractApplyMethod,
  extractApplyLink,
  extractSelfDeclaredNoticeDate,
  extractPostedDateFromBody,
  resolveYearlessMonthDay,
  classifyNotice,
  decideAutoPublishStatus,
  canonicalDedupKey,
  dedupeByCanonicalUrl,
  cleanTitle,
  extractAttachmentPdfUrls,
  fetchPdfText,
  fetchHwpxText,
  extractOnggiCandidates,
  extractHwp5BodyText,
  fetchHwpText,
  fetchTextWithCookie,
  fetchAttachmentPdfText,
  fetchText,
  stripHtmlPreserveLines,
};
