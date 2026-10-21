// 2026-10-22 신설: data/collected.json에서 noticeType이 "recruit"(실제 셀러/부스
// 모집공고로 분류된 항목)인 것만 골라 원문(+첨부 PDF)을 다시 fetch해서
// fetchAndClassifyDetail()로 재분류하고, 결과를 그 항목에만 "보완"한다.
//
// 절대 하지 않는 것:
//   - seen.json을 읽거나 쓰지 않음(신규 글 수집과 무관한, 이미 있는 항목 보완 전용).
//   - id/name/region/city/sourceOrg/sourceUrl/postedDate/collectedAt/status/
//     organizerType은 건드리지 않음(원본 메타데이터 보존).
//   - recruit가 아닌 나머지 항목은 전혀 조회하지 않음(이번 보완 대상이 아님).
//   - 원문에서 확인되지 않은 날짜/자격은 그대로 null로 둔다(추측 금지).
//
// 사용법:
//   node scripts/verify-recruit-notices.js            -> 재조회 결과만 출력(파일 변경 없음)
//   node scripts/verify-recruit-notices.js --write     -> 위 결과를 data/collected.json에 반영
const fs = require("fs");
const path = require("path");
const collect = require("./collect.js");

const DATA_PATH = path.join(__dirname, "..", "data", "collected.json");
const WRITE = process.argv.includes("--write");

async function main() {
  const items = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  const targets = items.filter((f) => f.noticeType === "recruit");
  console.log(`재검증 대상(noticeType==="recruit"): ${targets.length}건\n`);

  const patched = [];
  for (const item of items) {
    if (item.noticeType !== "recruit") {
      patched.push(item);
      continue;
    }
    console.log(`- ${item.id} ${item.name}`);
    let fresh;
    try {
      fresh = await collect.fetchAndClassifyDetail(
        item.sourceUrl,
        item.name,
        item.region,
        item.postedDate || null
      );
    } catch (err) {
      console.log(`  재조회 실패(${err.message}) — 기존 값 유지`);
      patched.push(item);
      continue;
    }
    const before = {
      noticeType: item.noticeType,
      applyStart: item.applyStart,
      applyEnd: item.applyEnd,
      eligibility: item.eligibility,
    };
    const after = {
      noticeType: fresh.noticeType,
      applyStart: fresh.applyStart,
      applyEnd: fresh.applyEnd,
      eligibility: fresh.eligibility,
    };
    console.log("  BEFORE:", JSON.stringify(before));
    console.log("  AFTER :", JSON.stringify(after));

    patched.push({
      ...item,
      applyStart: fresh.applyStart,
      applyEnd: fresh.applyEnd,
      festivalStart: fresh.festivalStart,
      festivalEnd: fresh.festivalEnd,
      venue: fresh.venue,
      boothCount: fresh.boothCount,
      fee: fresh.fee,
      facilities: fresh.facilities,
      applyMethod: fresh.applyMethod,
      noticeType: fresh.noticeType,
      boothType: fresh.boothType,
      recruitStatus: fresh.recruitStatus,
      eligibility: fresh.eligibility,
      ulsanEligible: fresh.ulsanEligible,
      eligibilityCategory: fresh.eligibilityCategory,
      restrictedRegion: fresh.restrictedRegion,
      linkStatus: fresh.linkStatus,
      linkCheckedAt: fresh.linkCheckedAt,
      linkCheckDetail: fresh.linkCheckDetail,
      memo: `${item.memo} [2026-10-22 재검증] ${fresh.memo}`,
    });
  }

  if (WRITE) {
    fs.writeFileSync(DATA_PATH, JSON.stringify(patched, null, 2));
    console.log(`\ndata/collected.json 갱신 완료 (총 ${patched.length}건, seen.json은 변경하지 않음)`);
  } else {
    console.log("\n(--write 없이 실행됨 — 파일은 변경되지 않았습니다)");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
