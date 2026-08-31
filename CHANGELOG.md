# 변경 이력

형식: [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/)

## [0.4.0] — 2026-08-31

### 추가
- `START-HERE.md` — 터미널 없이 GitHub·Notion·Slack 화면만으로 구축하는 단계별 안내
- `.github/workflows/setup-notion.yml` — Notion DB 생성을 Actions에서 실행
  (미리보기 / 새로 생성 / 기존 DB 속성 보강)

## [0.3.0] — 2026-08-27

### 추가
- Slack → Notion → GitHub 단방향 연동 구현
  - `integrations/slack/SETUP.md` — 채널 구성, Workflow 폼 설계(자유텍스트 파싱 배제)
  - `integrations/slack/gas/Code.gs` — 형식 1차 검증, 생년월일 마스킹, 스레드 회신
  - `integrations/notion/DB-SCHEMA.md` — DB 속성 정의 (evidence.schema.json 대응)
  - `scripts/sync-notion.js` — Notion → 원장 동기화, 증빙ID 자동 채번·되쓰기
  - `scripts/notify-slack.js` — 검증 결과 규칙별 요약 알림
  - `.github/workflows/sync.yml` — 매일 07:00 KST 동기화·검증·커밋·알림
- 비목코드·세목코드는 코드 마스터에서 자동 유도 (입력 오류 차단)
- `integrations/notion/setup-databases.js` — Notion DB 4종(정산증빙 30속성, 계약대장 25,
  중요재산 25, 준공산출물 22) 자동 생성·속성 보강. 선택지는 schema/common.schema.json 과
  codes/*.json 에서 유도하므로 스키마 변경이 Notion에 그대로 전파됨

## [0.2.0] — 2026-08-25

### 변경
- 보조비목 체계를 「보조사업 집행결과 제출 양식」 실제 통계목 코드로 교체
  (인건비 110 / 운영비 210 / 여비 220 / 연구개발비 260 / 민간이전 320 /
   건설비 420 / 유형자산 430 / 무형자산 440)
- `자산취득비`를 독립 비목에서 `유형자산(430)/자산취득비(01)`로 정정
- 지급방식 표기를 실제 사용값인 `보조금전용카드`로 통일
- 증빙 레코드의 `거래처`·`인건비상세`를 `지급처`(개인/사업자 구분)로 통합
- 금액 필드를 `집행금액` 단일 기준으로 정리 (`공급가액`·`부가세`는 선택)

### 추가
- `schema/budget.schema.json`, `data/budget.json` — 총괄명세서 예산집행계획(A) 원천
- `scripts/generate-report.js` — 집행결과 제출 양식 DOCX 자동 생성
- 검증규칙 R-05d(사용목적 부실), R-20(선금 미정산), R-21(생년월일 마스킹),
  R-22/R-22b(예산 초과집행·비목 외 집행)
- `SECURITY.md`, `docs/OPERATIONS.md`, PR 템플릿, 보고서 생성 워크플로

## [0.1.0] — 2026-08-25

### 추가
- JSON Schema 6종 및 코드 마스터 5종
- 검증기 R-01 ~ R-13 및 CI 워크플로
- GitHub 원장(Single Source of Truth) 운영 정책
