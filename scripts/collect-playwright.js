// 2026-10-23 신설: 북구청·동구청·남구청의 새올전자민원(eminwon) "고시공고" 목록
// 페이지는 접속하자마자 페이지 자체 JS가 OfrAction.do로 자동 POST를 보내 목록을
// 채우는 구조라, 순수 HTTP fetch()로는 빈 틀만 받아진다(실측: 헤드리스 브라우저로
// 렌더링하면 북구청 기준 행 54개가 나오는데 순수 fetch는 0개).
//
// 반면 글 하나의 상세 페이지는 그 글의 not_ancmt_mgt_no만 알면 같은 OfrAction.do를
// GET으로 직접 불러도 세션·쿠키 없이 동일하게 렌더링됨을 확인함(북구청 id=45217,
// 동구청·남구청 실제 글 ID로도 재확인). 그래서 헤드리스 브라우저는 "목록에 어떤 글이
// 있는지 알아내는" 용도로만 쓰고, 상세 조회·본문 분류·첨부파일(goDownLoad) 분석은
// collect.js의 기존 순수 HTTP 파이프라인(fetchAndClassifyDetail 등)을 그대로
// 재사용한다 — 이 모듈이 바뀌어도 이미 검증된 다른 지역 수집 로직에는 영향이 없음.
//
// playwright는 이 모듈 안에서만 지연 로딩한다: 설치가 안 된 환경(또는 설치돼 있어도
// 브라우저 바이너리가 없는 환경)에서도 collect.js의 나머지 수집은 전혀 영향받지
// 않고, 이 기관들만 "fetch_failed"로 분리돼 보고되게 하기 위함.

const LIST_WAIT_TIMEOUT_MS = 20000;

function loadChromium() {
  return require("playwright").chromium;
}

// 목록에 실제 글 제목과 무관하게 섞여 들어오는 행(순번 숫자만 있는 셀, 날짜만 있는
// 셀)을 걸러낸다 — 실측: eminwon 목록 테이블은 같은 <a onclick="searchDetail(...)">가
// 제목뿐 아니라 번호·날짜 칸에도 걸려 나옴.
function isRealTitle(text) {
  return text.length > 8 && !/^\d+$/.test(text) && !/^\d{4}-\d{2}-\d{2}$/.test(text);
}

// 헤드리스 브라우저로 목록 페이지를 렌더링해 "키워드와 맞는 글의 제목 + 상세조회 ID"만
// 뽑아낸다. not_ancmt_se_code 파라미터를 생략하면 고시·공고 전체 카테고리가 한 번에
// 나옴(실측 확인) — 카테고리 코드를 추측할 필요가 없어, 분류는 전부 keywordRe에 맡긴다.
async function fetchEminwonCandidates(listUrl, keywordRe, noiseRe) {
  const chromium = loadChromium();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(listUrl, { waitUntil: "networkidle", timeout: LIST_WAIT_TIMEOUT_MS });
    await page.waitForTimeout(500);
    const rows = await page.$$eval("a[onclick*='searchDetail']", (els) =>
      els.map((e) => ({ text: e.textContent.trim(), onclick: e.getAttribute("onclick") }))
    );
    const out = [];
    for (const r of rows) {
      if (!isRealTitle(r.text)) continue;
      if (!keywordRe.test(r.text)) continue;
      if (noiseRe && noiseRe.test(r.text)) continue;
      const m = r.onclick && r.onclick.match(/searchDetail\('([^']+)'\)/);
      if (!m) continue;
      out.push({ id: m[1], title: r.text });
    }
    return out;
  } finally {
    await browser.close();
  }
}

// 목록에서 찾은 글 ID로, 그 글만 가리키는 고정된 상세 URL을 직접 구성한다(GET,
// 세션/쿠키 불필요 — 실측 확인). 이 URL이 data/collected.json의 sourceUrl로 그대로
// 저장되므로 공고마다 고유하고 변하지 않는 링크가 보장된다. title/not_ancmt_se_code는
// 빈 값이어도 동일하게 렌더링됨을 확인해(카테고리 코드를 추측해 넣을 필요 없음) 비워둔다.
function buildEminwonDetailUrl(host, notAncmtMgtNo) {
  const params = new URLSearchParams({
    pageIndex: "",
    jndinm: "OfrNotAncmtEJB",
    context: "NTIS",
    method: "selectOfrNotAncmt",
    methodnm: "selectOfrNotAncmtRegst",
    not_ancmt_mgt_no: notAncmtMgtNo,
    homepage_pbs_yn: "Y",
    subCheck: "Y",
    ofr_pageSize: "10",
    not_ancmt_se_code: "",
    title: "",
    cha_dep_code_nm: "",
    initValue: "Y",
    countYn: "Y",
    list_gubun: "",
    not_ancmt_sj: "",
  });
  return `https://${host}/emwp/gov/mogaha/ntis/web/ofr/action/OfrAction.do?${params.toString()}`;
}

// 2026-10-23 신설: 목록 화면은 긴 제목을 "..."로 잘라서 보여준다(실측: 북구청
// id=45135 "...뉴:빌리지사업 도시재생활성화계획 변경 고..." — 서버가 내려주는 목록
// HTML 자체가 이미 잘려 있어 목록만으로는 전체 제목을 복원할 수 없음). 반면 상세
// 페이지는 "<th>제목</th><td colspan=3>전체 제목</td>" 형태로 항상 전체 제목을
// 담고 있음(같은 글의 상세페이지에서 "...변경 고시"까지 전부 확인). 그래서 상세
// 페이지를 한 번 더 받아 이 자리의 텍스트로 목록 제목을 보정한다.
const DETAIL_TITLE_RE = /<th[^>]*>\s*제목\s*<\/th>\s*<td[^>]*>([^<]+)<\/td>/;
function extractEminwonDetailTitle(html) {
  const m = html.match(DETAIL_TITLE_RE);
  return m ? m[1].trim() : null;
}

module.exports = { fetchEminwonCandidates, buildEminwonDetailUrl, extractEminwonDetailTitle };
