# 해외 IP 차단 기관(쇠부리축제·마두희축제·울산연극협회)만 사용자 PC(한국 IP)에서 수집해 push한다.
# GitHub Actions에서는 이 기관들이 403/404로 막혀 collect.js가 건너뛴다(KR_IP_ONLY_ORGS 참고).
# 윈도우 작업 스케줄러가 매일 1회 실행 — PC가 꺼져 있었으면 다음에 켜질 때 실행된다.
$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
$log = Join-Path $env:TEMP "festival-kr-local.log"
Start-Transcript -Path $log -Append | Out-Null
try {
  Write-Host "=== $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') kr-local 수집 시작 ==="
  git pull --rebase --autostash origin main
  if ($LASTEXITCODE -ne 0) { throw "git pull 실패" }

  $env:COLLECT_SCOPE = "kr-local"
  node scripts/collect.js
  if ($LASTEXITCODE -ne 0) { throw "collect.js 실패 (exit $LASTEXITCODE)" }

  git add data/collected.json data/seen.json data/board_status.json data/run_history.json
  git diff --cached --quiet
  if ($LASTEXITCODE -eq 0) { Write-Host "변경 없음 — push 생략"; return }

  git commit -m "chore: local kr-only collection $(Get-Date -Format 'yyyy-MM-dd')"
  # Actions가 그사이 push했을 수 있으니 한 번 더 rebase 후 push
  git pull --rebase --autostash origin main
  if ($LASTEXITCODE -ne 0) { throw "push 전 git pull 실패" }
  git push origin main
  if ($LASTEXITCODE -ne 0) { throw "git push 실패" }
  Write-Host "push 완료"
} finally {
  Stop-Transcript | Out-Null
}
