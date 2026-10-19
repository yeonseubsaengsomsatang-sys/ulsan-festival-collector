# ulsan-festival-collector

울산광역시 5개 구·군청을 포함해 **전국 17개 시도** 소속 기관 게시판에서 축제/행사/
체험부스/판매부스/프리마켓/푸드트럭 셀러 모집공고를 매일 자동으로 수집합니다.
LLM(Claude 등) 호출이 전혀 없는 순수 HTTP + 정규식 스크립트이며, GitHub Actions
무료 티어에서 매일 1회 실행됩니다.

## 동작 방식

1. `scripts/collect.js`가 각 기관 게시판 URL을 가져와 제목에 축제/부스/셀러 관련 키워드가
   포함된 링크만 추출합니다.
2. `data/seen.json`과 대조해 **이전에 본 적 없는 글만** `data/collected.json`에 추가합니다.
3. 기관(게시판)별로 이번 실행에서 fetch에 성공했는지/실패했는지를 `data/board_status.json`에
   기록합니다(기관 단위로 묶음 — 같은 기관 게시판이 여러 개면 하나라도 성공하면 "ok").
4. GitHub Actions가 결과를 커밋 → `data/collected.json`과 `data/board_status.json`이
   `https://raw.githubusercontent.com/<OWNER>/<REPO>/main/data/<파일명>` 로 공개됩니다.
5. 홈페이지(Claude Artifact "축제 신청 캘린더")가 이 데이터를 Artifact DB의
   `collected_festivals` 컬렉션으로 동기화해 "자동수집 대기" 큐에 병합합니다. 이
   동기화는 GitHub Actions가 직접 하지 못하므로(Artifact DB는 Claude 세션에서만 쓸 수
   있음) Claude Code 예약 작업이 매일 수행합니다 — 자세한 내용은 아래 "홈페이지 연동" 참고.

## 설치

1. 이 폴더 전체를 새 GitHub 저장소(public)에 업로드합니다.
2. 저장소 Settings → Actions → General → Workflow permissions에서
   **"Read and write permissions"**를 선택합니다 (커밋을 위해 필요).
3. Actions 탭에서 `Collect Ulsan festival/booth postings` 워크플로를 확인하고,
   `workflow_dispatch`로 한 번 수동 실행해서 정상 동작하는지 확인합니다.
4. 매일 07:00(KST)에 자동 실행됩니다. 시간을 바꾸려면
   `.github/workflows/collect.yml`의 cron 값을 수정하세요 (UTC 기준).

## 실행 로그로 확인할 것

`scripts/collect.js`의 각 게시판 어댑터는 전부 실제 HTML을 직접 fetch해서 앵커/날짜
마크업을 확인한 뒤에만 등록합니다(추측 URL 등록 금지 원칙). 그래도 정부 사이트는
예고 없이 마크업이 바뀌므로, 실행 로그의 "N건 매칭 (원본 앵커 M개 중)" 줄과 실행 맨
마지막의 "=== 기관별 수집 상태 ===" 요약을 확인하세요.

- M(원본 앵커 수)이 갑자기 0이거나 급감하면 그 게시판 마크업이 바뀌었을 가능성이 높습니다.
- "기관별 수집 상태"에 "[실패]"로 나오는 기관은 이번 실행에서 그 기관의 게시판 전부가
  fetch 자체에 실패한 것입니다(`data/board_status.json`에도 `status: "fetch_failed"`로
  남습니다) — 일시적 네트워크 문제일 수도 있고 사이트 구조가 바뀐 것일 수도 있으니
  다음 실행에서도 계속 실패하면 해당 게시판 URL을 다시 확인해야 합니다.

## 비용

- GitHub Actions: 하루 1~2분 실행, 무료 한도(월 2,000분, private 저장소 기준) 대비 거의 0%.
- LLM 호출: 없음.
- **월 예상 비용: $0**

## 홈페이지 연동

홈페이지(Claude Artifact "축제 신청 캘린더")는 이 저장소의 JSON을 직접 fetch하지 않고,
자체 Artifact DB(`collected_festivals` 컬렉션)를 읽어 "자동수집 대기" 큐를 그립니다.
GitHub Actions는 Artifact DB에 직접 쓸 수 없으므로(이 쓰기는 Claude 세션 안에서만
가능), `data/collected.json` → Artifact DB 동기화는 매일 Claude Code 예약 작업이
대신 수행합니다: 이 저장소의 최신 `collected.json`을 읽어 아직 DB에 없는 글만
`id` 기준으로 새로 써넣습니다. 화면 디자인은 바뀌지 않고, 자동수집 대기 큐의
데이터만 매일 최신 상태로 유지됩니다.
