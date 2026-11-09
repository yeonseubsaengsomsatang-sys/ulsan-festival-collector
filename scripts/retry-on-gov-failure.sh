#!/usr/bin/env bash
# 2026-11-09 신설(요청사항 — 자동 수집 안정화): 울산 관공서 6곳이 "모두" 접속에 실패한 실행에서만
# 새 서버(새 IP)로 수집을 1회 다시 요청한다. 실행마다 배정되는 GitHub 서버 IP 일부가 울산 관공서에
# 연결되지 않는 현상(11/7·11/8 실측, 지역과 무관)에 대한 대응.
#
# 보호 장치
#  - 재실행으로 시작된 실행(IS_RETRY=true)은 다시 재실행을 요청하지 않는다(무한 반복 방지, 최대 1회).
#  - 울산 범위(ulsan) 실행에서만 동작한다.
#  - 지금 실행 외에 대기 중이거나 실행 중인 수집 작업이 있으면 요청하지 않는다(중복 실행 방지).
#    (워크플로의 concurrency: collect 설정으로도 수집은 한 번에 하나만 돈다.)
#  - 이 단계가 실패해도 수집 결과에는 영향이 없도록 항상 0으로 끝난다.
#
# 입력(환경변수): GOV_ALL_FAILED, IS_RETRY, RUN_ID, REASON, SCOPE, GH_TOKEN(워크플로에서 전달)
set -u

say() {
  echo "$1"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then echo "- 자동 재실행 판단: $1" >> "$GITHUB_STEP_SUMMARY"; fi
}

if [ "${GOV_ALL_FAILED:-false}" != "true" ]; then
  say "울산 관공서가 모두 실패하지는 않음 — 재실행 안 함"
  exit 0
fi
if [ "${IS_RETRY:-false}" = "true" ]; then
  say "이미 자동 재실행된 실행이라 추가 재실행 안 함(최대 1회, 무한 반복 방지)"
  exit 0
fi
if [ "${SCOPE:-ulsan}" != "ulsan" ]; then
  say "수집 범위가 ${SCOPE} — 울산 범위가 아니라 재실행 안 함"
  exit 0
fi

others=$(gh run list --workflow=collect.yml --limit 20 --json databaseId,status \
  -q "[.[] | select((.status==\"queued\" or .status==\"in_progress\" or .status==\"waiting\" or .status==\"pending\" or .status==\"requested\") and (.databaseId|tostring) != \"${RUN_ID}\")] | length" 2>/dev/null)
if [ -z "$others" ]; then
  say "다른 수집 작업 확인에 실패해 안전하게 재실행 안 함"
  exit 0
fi
if [ "$others" -gt 0 ]; then
  say "다른 수집 작업 ${others}건이 대기·실행 중이라 재실행 생략(중복 실행 방지)"
  exit 0
fi

if gh workflow run collect.yml -f scope=ulsan -f retry=true -f retry_of="${RUN_ID}" -f retry_reason="${REASON:-?}"; then
  say "관공서 전체 실패(${REASON:-?}) — 새 서버에서 1회 재실행을 요청함(원 실행 #${RUN_ID})"
else
  say "재실행 요청에 실패함 — 다음 예약 실행에서 다시 수집됨"
fi
exit 0
