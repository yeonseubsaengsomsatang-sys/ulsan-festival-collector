// 2026-10-22 일회성 정리 스크립트: data/collected.json에 이미 들어있는 중복 항목
// (같은 글이 파라미터만 다른 URL로 두 번 수집된 경우)을 collect.js의
// dedupeByCanonicalUrl()로 한 번에 정리한다. 이 함수는 앞으로 scripts/collect.js의
// main() 안에서도 매일 자동으로 적용되므로, 이 스크립트는 "그 기준이 생기기 전에
// 이미 들어가 있던" 과거 중복만 정리하는 1회성 백필이다.
//
// 레코드를 지우거나 status를 바꾸지 않는다 — 건수와 승인 상태를 그대로 보존하기 위해,
// 중복된 나머지 항목에는 duplicateOf 필드만 추가한다(홈페이지가 이 필드가 있는 항목을
// 공개 목록에서만 건너뜀).
//
// 사용법:
//   node scripts/dedupe-existing.js          -> 중복 표시 대상만 출력(파일 변경 없음)
//   node scripts/dedupe-existing.js --write   -> 위 결과를 data/collected.json에 반영
const fs = require("fs");
const path = require("path");
const collect = require("./collect.js");

const DATA_PATH = path.join(__dirname, "..", "data", "collected.json");
const WRITE = process.argv.includes("--write");

function main() {
  const items = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  const deduped = collect.dedupeByCanonicalUrl(items);
  const byId = new Map(items.map((i) => [i.id, i]));
  const newlyMarked = deduped.filter((i) => i.duplicateOf && !byId.get(i.id).duplicateOf);

  console.log(`원본 ${items.length}건 -> 정리 후 ${deduped.length}건 (건수 변화 없음, 중복 표시 ${newlyMarked.length}건)`);
  newlyMarked.forEach((i) => console.log(`- 중복 표시: ${i.id} ${i.name} (status=${i.status} 유지, duplicateOf=${i.duplicateOf})`));

  if (WRITE) {
    fs.writeFileSync(DATA_PATH, JSON.stringify(deduped, null, 2));
    console.log("data/collected.json 갱신 완료 (건수·status 변경 없음, seen.json도 변경하지 않음)");
  } else {
    console.log("(--write 없이 실행됨 — 파일은 변경되지 않았습니다)");
  }
}

main();
