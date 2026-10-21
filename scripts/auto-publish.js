// 2026-10-22 신설: 관리자 승인 없이도 안전하게 홈페이지에 반영할 수 있는 기존 공고를
// 한 번에 정리하는 백필(backfill) 스크립트. scripts/collect.js의 decideAutoPublishStatus()
// (매일 GitHub Actions가 새 글을 찾을 때 이미 적용하는 것과 완전히 같은 기준)를 재사용해,
// 이 기준이 생기기 "전에" 수집돼 전부 "pending"으로 남아있던 기존 공고 중 실제 셀러·
// 푸드트럭·체험부스·프리마켓 모집공고로 확인된 것만 "approved"로 승격한다.
//
// 절대 하지 않는 것:
//   - data/seen.json은 전혀 읽거나 쓰지 않음.
//   - status가 "pending"이 아닌 항목(이미 approved/rejected된 것)은 건드리지 않음.
//   - noticeType/boothType 등 분류 필드 자체를 다시 추출하지 않음(재검증은
//     scripts/verify-recruit-notices.js의 역할) — 이미 저장된 분류 결과만으로 판정.
//
// 사용법:
//   node scripts/auto-publish.js          -> 승격 대상만 출력(파일 변경 없음)
//   node scripts/auto-publish.js --write   -> 위 결과를 data/collected.json에 반영
const fs = require("fs");
const path = require("path");
const collect = require("./collect.js");

const DATA_PATH = path.join(__dirname, "..", "data", "collected.json");
const WRITE = process.argv.includes("--write");

function main() {
  const items = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  let changed = 0;
  const patched = items.map((item) => {
    if (item.status !== "pending") return item;
    const nextStatus = collect.decideAutoPublishStatus({
      noticeType: item.noticeType,
      boothType: item.boothType,
    });
    if (nextStatus === item.status) return item;
    changed++;
    console.log(`- ${item.id} ${item.name} : pending -> ${nextStatus}`);
    return { ...item, status: nextStatus };
  });

  console.log(`\n대상 ${items.length}건 중 ${changed}건을 pending -> approved로 전환합니다.`);
  if (WRITE) {
    fs.writeFileSync(DATA_PATH, JSON.stringify(patched, null, 2));
    console.log("data/collected.json 갱신 완료 (seen.json은 변경하지 않음)");
  } else {
    console.log("(--write 없이 실행됨 — 파일은 변경되지 않았습니다)");
  }
}

main();
