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

const LIST_WAIT_TIMEOUT_MS = 40000; // 2026-11-03: 20s→40s (느린 구청 서버 대응)

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
    // 2026-11-03 수정(버그 — 점검 요청으로 발견): 목록은 페이지 로드 1~2초 뒤에 JS가
    // 그린다. 예전엔 0.5초만 기다려 북구 목록을 항상 0건으로 읽었음(로그상 "0건 매칭"이라
    // 공고가 없는 것처럼 보였음). 글 링크가 실제로 나타날 때까지 최대 15초 기다리고,
    // 그래도 안 나타나면 "목록 0건"이 아니라 실패로 처리해 board_status에 드러나게 한다.
    await page.waitForSelector("a[onclick*='searchDetail']", { timeout: 15000 });
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

// 2026-11-08 신설(민간 수집 2차 — 승인됨): 플리모아(fleamoa.com) "외부마켓소식" 울산 공고.
// 화면을 브라우저 안에서 그리는 사이트라, 일반 방문자처럼 공개 페이지를 열어 "화면에 보이는
// 글자"만 읽는다. 로그인하지 않고, robots.txt가 막은 경로(/my, /apply 등)는 열지 않으며,
// 사이트 내부 데이터 주소를 직접 호출하지 않는다. 지역 필터(울산)는 화면의 필터 버튼으로 고른다.
const FLEAMOA_NEWS_URL = "https://fleamoa.com/market-news.html";
const FLEAMOA_FIELD_LABELS = ["일시", "장소", "부스비", "부스 규격", "모집 부스", "선정 방식"];

async function fetchFleamoaUlsanMarkets() {
  const chromium = loadChromium();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ locale: "ko-KR" });
    await page.goto(FLEAMOA_NEWS_URL, { waitUntil: "domcontentloaded", timeout: LIST_WAIT_TIMEOUT_MS });
    await page.waitForSelector('a[href*="market-detail"]', { timeout: 30000 });
    await page.getByText("지역 전체 ▾").click();
    await page.locator("#rfSheet").getByText(/^울산/).first().click();
    await page.locator("#rfSheet").getByText("적용하기").click();
    await page.waitForTimeout(2500);

    const cards = new Map();
    for (const tab of ["모집중", "마감"]) {
      await page.locator(`button:has-text("${tab}")`).first().click();
      await page.waitForTimeout(2500);
      const found = await page.$$eval('a[href*="market-detail"]', (els) =>
        els.map((e) => ({ href: e.href, text: e.innerText.replace(/\s+/g, " ").trim() }))
      );
      for (const c of found) {
        if (!/울산/.test(c.text)) continue; // 필터가 풀려도 울산 아닌 카드는 절대 담지 않음
        if (!cards.has(c.href)) cards.set(c.href, { ...c, tab });
      }
    }

    const out = [];
    for (const card of cards.values()) {
      await page.goto(card.href, { waitUntil: "domcontentloaded", timeout: LIST_WAIT_TIMEOUT_MS });
      await page.waitForSelector("h1, h2", { timeout: 20000 });
      await page.waitForTimeout(2500);
      const d = await page.evaluate((labels) => {
        const title = ((document.querySelector("h1") || document.querySelector("h2") || {}).innerText || "").trim();
        const lines = document.body.innerText.split("\n").map((s) => s.trim()).filter(Boolean);
        const fields = {};
        for (const label of labels) {
          const i = lines.indexOf(label);
          if (i !== -1 && lines[i + 1] && !labels.includes(lines[i + 1])) fields[label] = lines[i + 1];
        }
        const introIdx = lines.indexOf("마켓 소개");
        const intro = introIdx !== -1 ? lines.slice(introIdx + 1, introIdx + 4).join(" ") : "";
        const subtitle = lines.find((l) => /^울산\s/.test(l) && l.includes("·")) || "";
        const src = (lines.find((l) => /^출처:/.test(l)) || "").replace(/^출처:\s*/, "").replace(/\s*·.*$/, "");
        const originalUrl = [...document.querySelectorAll("a")].filter((a) => /원문/.test(a.innerText)).map((a) => a.href)[0] || null;
        return { title, fields, intro, subtitle, src, originalUrl };
      }, FLEAMOA_FIELD_LABELS);
      out.push({ url: card.href, tab: card.tab, listText: card.text, ...d });
    }
    return out;
  } finally {
    await browser.close();
  }
}

module.exports = { fetchEminwonCandidates, buildEminwonDetailUrl, extractEminwonDetailTitle, fetchFleamoaUlsanMarkets };
