# 단위시스템 연동

이미 운영 중인 단위시스템에서 데이터를 자동으로 가져와 정산 원장을 채운다.
사람이 재입력하지 않는다. scripts/connect-units.js 가 매일 06:30 실행.

## 연동 소스

| 시스템 | 데이터 URL | 정산에 반영 | 갱신 |
|---|---|---|---|
| BMS 예산관리 | `.../BMS-/main/data/budget.json` | 재원(국비/도비/시비) 안분 → R-24 해소 | 매일 |
| WBS 진척 | `.../WBS/main/data/summary-data.json` | 준공 물리적 진도율 | 매일 |
| HR 포털 | `.../HR-Management-Portal/main/data/hr.json` | 참여인력 59명·참여율 | 매일 |
| 자산관리 | `.../asset-management/main/data/assets.json` | 중요재산 98건 (Notion 경유) | 수시 |

## 통합포털과의 관계

통합포털(Asan-Smartcity-integration-Portal)은 BMS·WBS 를 fetch 해 한 화면에
모아 보여주는 뷰다. 자체 데이터는 없다. 정산시스템은 같은 소스를 읽되,
**뷰가 아니라 원장으로** 받아 검증·산출물 생성까지 한다.

즉 통합포털 = 예산·진척 조회 화면, 정산시스템 = 그 데이터로 법정서식까지 생성.
소스가 같으므로 두 시스템의 숫자는 항상 일치한다.

## 자동 흐름

```
BMS·WBS·HR·자산관리 (각자 매일 갱신)
        ↓ connect-units.js (매일 06:30 KST)
data/*.json 원장 자동 갱신
        ↓
검증 → 법정서식·정산보고서·준공서류·종합엑셀 자동 생성 → 대시보드
```
