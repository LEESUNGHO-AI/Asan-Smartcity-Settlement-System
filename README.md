# 아산시 강소형 스마트시티 조성사업 — 정산시스템 (SMS)

> **⚠ 이 리포지토리는 private으로만 운영한다.** 참여인력·평가위원의 성명과 생년월일,
> 거래처 사업자등록번호가 포함된다. 공개 전환·Fork·Transfer 금지. → [SECURITY.md](SECURITY.md)

### 👉 처음 구축하신다면 **[START-HERE.md](START-HERE.md)** 부터 보십시오. 터미널 없이 화면만으로 끝납니다.

**`data/*.json`이 정산 데이터의 정본(Single Source of Truth)이다.**
Notion·Slack·Excel은 입력 채널이자 조회 화면이며, 값이 충돌하면 언제나 이 리포지토리가 우선한다.

| 항목 | 내용 |
|---|---|
| 사업명 | '23년 강소형 아산시 스마트시티 조성사업 (디지털 OASIS) |
| 사업기간 | 2023. 12. 11. ~ 2026. 12. 31. |
| 총사업비 | 24,000,000,000원 |
| 수행체계 | 아산시(보조사업자) — 제일엔지니어링(직접보조·PMO) — 호서대·충남연구원·KAIST(간접보조) |
| 소관부처 | 국토교통부 / 한국스마트도시협회 |
| 관리 | ㈜제일엔지니어링종합건축사사무소 PMO · 상무 이성호 |

---

## 왜 GitHub이 정본인가

정산은 2031년까지 감사 대응이 필요하다. 감사에서 문제가 되는 것은 "지금 값이 얼마인가"가 아니라
**"이 값이 언제, 누구에 의해, 무엇을 근거로 바뀌었는가"** 다.

| | Notion 원장 | GitHub 원장 |
|---|---|---|
| 변경 이력 | 최근 이력만, 소급 편집 가능 | 커밋 단위 영구 보존, 위·변조 불가 |
| 변경 사유 | 별도 기록 필요 | 커밋 메시지 = 사유 |
| 승인 절차 | 없음 | Pull Request 리뷰 |
| 법정요건 검증 | 수작업 | CI 자동 검증 |
| 시점 복원 | 불가 | 임의 시점 체크아웃 |

커밋 히스토리 자체가 증거능력을 갖는다는 점이 결정적이다.

---

## 구조

```
schema/     JSON Schema 7종 — 데이터 구조의 법률적 정의
  common          공통 타입·열거값 (기관·비목·재원·지급처·증빙유형)
  baseline        협약·교부결정·법정 임계값·미확정사항
  budget          비목·세목별 예산집행계획(A)
  evidence        증빙대장 — 집행결과 제출 양식의 원천
  contracts       계약대장
  assets          중요재산대장
  completion      준공산출물 대장

codes/      코드 마스터 — 기관, 단위사업, 보조비목·세목, 준공문서, 재원
data/       ★정본★ 원장 데이터
rules/      RULES.md — 검증규칙 ↔ 법령 매핑표 (R-01 ~ R-22)
scripts/    validate.js (검증), generate-report.js (양식 생성)
docs/       OPERATIONS.md — 원장 운영 매뉴얼
integrations/  Slack·Notion 연동 (설정 문서, GAS 스크립트)
output/     생성 산출물 (커밋 대상 아님)
```

---

## 사용법

```bash
npm install

npm run validate         # 스키마 + 법정요건 검증
npm run validate:strict  # 경고도 오류로 취급
npm run validate:json    # 기계 판독용 JSON 출력

npm run report -- --org JEIL --from 2025-10-01 --to 2026-06-30

npm run sync             # Notion → data/evidence.json
npm run sync:dry         # 변경사항만 확인
npm run notify           # 검증 결과 Slack 전송
```

`npm run report`는 「별첨4 보조사업 집행결과 제출 양식」 DOCX를 `output/`에 생성한다.
1.사업개요 → 2.집행내역 → 3.보조비목별 총괄명세서 → 4.일자별 집행내역 →
4-1.세부집행내역(비목별 하위절 포함) 구조를 원본 그대로 재현하며,
인건비·여비는 성명/생년월일/참여율 열로, 그 외 비목은 지급처/사업자등록번호 열로 자동 전환된다.

GitHub Actions에서 `집행결과 제출 양식 생성` 워크플로를 수동 실행하면
검증 통과 시에만 DOCX가 Artifact로 산출된다.

---

## 검증

두 단계로 이루어진다.

1. **스키마 검증** — 구조·타입·열거값 위반
2. **규칙 검증** — 보조금법령·통합관리지침상 요건 위반 (R-01 ~ R-22, [rules/RULES.md](rules/RULES.md))

오류가 1건이라도 있으면 CI가 실패하고 **보고서 산출이 차단된다.**

주요 규칙:

| 규칙 | 판정 | 근거 |
|---|---|---|
| R-01 | 기준정보 미확정 시 산출 차단 | 협약서·교부결정통지서 |
| R-02 | 계좌이체·보조금전용카드 외 지급 | 통합관리지침 §18① |
| R-03 | 계약서 등록 15일 초과 | 통합관리지침 §21④ |
| R-04 | 임계액 초과 계약의 조달 절차 미이행 | 통합관리지침 §21③·§22① |
| R-06 | 중요재산 미등재·보고 지연·처분제한기간 오류 | 보조금법 §35 / 지침 §46 |
| R-08 | 인건비 증빙 결손·참여율 100% 초과 | 작성지침 §5 |
| R-11 | 낙찰차액 반납 대상 | 통합관리지침 §17①·§26① |
| R-20 | 선금 미정산 | 통합관리지침 §18 |
| R-21 | 생년월일 마스킹 누락 | 개인정보 보호법 §29 |
| R-22 | 예산 초과집행·비목 외 집행 | 보조금법 §22 |

---

## 운영 원칙

**기준정보 우선.** `baseline.json`의 `confirmed: false`가 하나라도 남으면 R-01 오류가 발생한다.
협약서 원문·국토부 회신으로 확정한 뒤에만 `true`로 바꾼다. 추정치를 확정으로 표기하지 않는다.

**ID는 불변.** `EV-YYYY-NNNNN`, `CT-YYYY-NNNN`, `AS-YYYY-NNNN`, `CP-YYYY-NNNN`.
부여한 ID는 변경·재사용하지 않는다. 삭제 대신 `검토상태: 불인정`으로 남긴다.

**임계값은 하드코딩 금지.** 2천만원·2억원·30억원·15일·50만원은 모두 `baseline.json`에 있다.
법령이 개정되면 baseline만 고치고, 그 커밋이 개정 반영 시점의 증거가 된다.

**증빙 파일 본체는 커밋하지 않는다.** `파일링크`에 URL만 보관한다.

자세한 내용은 [docs/OPERATIONS.md](docs/OPERATIONS.md).

---

## 현재 상태

- [x] 스키마 7종 · 코드 마스터 5종
- [x] 검증기 R-01 ~ R-22
- [x] 집행결과 제출 양식 DOCX 생성기
- [x] CI(검증) · 수동 워크플로(보고서 생성)
- [ ] **기준정보 확정 — 협약서 원문 대조 대기 (블로커)**

> 최초 push 시 CI는 **의도적으로 실패**한다. 기준정보가 미확정이고 중요재산이 미등재된
> 현재 상태를 시스템이 정확히 지적하고 있는 것이다. 아래 항목을 해소하면 자동으로 통과한다.
>
> `R-01` 기준정보 미확정 · `R-03` 계약서 등록 지연 · `R-06` 무형자산 3건 중요재산 미등재 · `R-11` 낙찰차액 8천만원
- [ ] 전체 증빙 이관 (현재 시드 39건, 실제 약 700건)
- [x] Slack → Notion → GitHub 연동 (`integrations/`, `scripts/sync-notion.js`)
- [ ] 정산 대시보드 (GitHub Pages, 집계값만)

---

## 연동

```
Slack (Workflow 폼) → GAS (형식검증·마스킹) → Notion (검토) → GitHub (정본) → Slack (결과 알림)
```

데이터는 한 방향으로만 흐른다. 되돌아오는 것은 검증 결과뿐이며,
값을 고치는 것은 언제나 Notion 또는 PR에서 한다.
자세한 내용은 [integrations/README.md](integrations/README.md).

필요한 Secrets: `NOTION_TOKEN`, `NOTION_EVIDENCE_DB`, `SLACK_WEBHOOK_URL`

## 관련 리포지토리

| 시스템 | 연계 키 |
|---|---|
| Asan-Smart-City-Budget-Management-System-BMS- | 비목 코드 |
| Asan-Smartcity-WBS | 단위사업 코드 |
| Asan-asset-management | 자산ID |
| Asan-HR-Management-Portal | 참여인력·참여율 |
| Asan-Report-Generator | 보고서 서식 |

---

*㈜제일엔지니어링종합건축사사무소 PMO / 상무 이성호*
