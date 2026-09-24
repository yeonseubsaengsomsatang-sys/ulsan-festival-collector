# ulsan-festival-collector

울산광역시 및 5개 구·군청 게시판에서 축제/행사/체험부스/판매부스/프리마켓 셀러 모집공고를
매일 자동으로 수집합니다. LLM(Claude 등) 호출이 전혀 없는 순수 HTTP + 정규식 스크립트이며,
GitHub Actions 무료 티어에서 매일 1회 실행됩니다.

## 동작 방식

1. `scripts/collect.js`가 각 기관 게시판 URL을 가져와 제목에 축제/부스/셀러 관련 키워드가
   포함된 링크만 추출합니다.
2. `data/seen.json`과 대조해 **이전에 본 적 없는 글만** `data/collected.json`에 추가합니다.
3. GitHub Actions가 결과를 커밋 → `data/collected.json`이
   `https://raw.githubusercontent.com/<OWNER>/<REPO>/main/data/collected.json` 로 공개됩니다.
4. 홈페이지(Claude Artifact)가 이 JSON을 fetch해서 "자동수집 대기" 큐에 병합합니다
   (별도 코드 패치 필요 — 아래 참고).

## 설치

1. 이 폴더 전체를 새 GitHub 저장소(public)에 업로드합니다.
2. 저장소 Settings → Actions → General → Workflow permissions에서
   **"Read and write permissions"**를 선택합니다 (커밋을 위해 필요).
3. Actions 탭에서 `Collect Ulsan festival/booth postings` 워크플로를 확인하고,
   `workflow_dispatch`로 한 번 수동 실행해서 정상 동작하는지 확인합니다.
4. 매일 06:00(KST)에 자동 실행됩니다. 시간을 바꾸려면
   `.github/workflows/collect.yml`의 cron 값을 수정하세요 (UTC 기준).

## 실행 로그로 확인할 것 (첫 실행 시 중요)

`scripts/collect.js`의 각 게시판 어댑터는 신뢰도가 다릅니다:

- **VERIFIED**: 이번 조사에서 실제 HTML을 직접 확인한 URL — 북구청 3개 게시판, 동구청 검색,
  울주군청 검색.
- **INFERRED**: 그 사이트의 view/list URL 명명 규칙으로 유추한 것 — 중구청, 남구청, 울산시청.
  실제로 목록이 나오는지 첫 실행 로그의 "N건 매칭 (원본 앵커 M개 중)" 줄을 확인하세요.
  M(원본 앵커 수)이 0이거나 매우 작으면 그 URL이 잘못됐을 가능성이 높습니다 — 해당 기관
  게시판을 다시 확인해서 `scripts/collect.js`의 `BOARDS` 배열 URL을 고쳐야 합니다.

## 비용

- GitHub Actions: 하루 1~2분 실행, 무료 한도(월 2,000분, private 저장소 기준) 대비 거의 0%.
- LLM 호출: 없음.
- **월 예상 비용: $0**

## 홈페이지 쪽 연동 (별도로 안내드릴 코드 패치)

`data/collected.json`이 채워지기 시작하면, Claude에게 저장소 URL(`OWNER/REPO`)을
알려주면 홈페이지 아티팩트에 이 JSON을 읽어와 기존 "자동수집 대기" 큐에 병합하는
코드 몇 줄을 추가해줍니다. 화면 디자인은 바뀌지 않고, 데이터 소스만 하나 늘어납니다.
