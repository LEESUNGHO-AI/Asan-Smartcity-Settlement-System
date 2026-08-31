# 연동 아키텍처

```
   ┌─────────┐   Workflow Form    ┌──────────┐   Apps Script   ┌──────────┐
   │  Slack  │ ─────────────────▶ │   GAS    │ ──────────────▶ │  Notion  │
   │ 입력 채널│                    │ 파싱·검증 │                 │ 검토 화면 │
   └─────────┘                    └──────────┘                 └────┬─────┘
        ▲                                                            │
        │                                                            │ sync-notion.js
        │  검증 결과 알림                                              │ (GitHub Actions, 매일 07:00 KST)
        │  notify-slack.js                                            ▼
        │                                                       ┌──────────┐
        └────────────────────────────────────────────────────── │  GitHub  │
                                                                │ data/*.json│
                                                                │  ★정본★   │
                                                                └──────────┘
```

## 원칙

**데이터는 한 방향으로만 흐른다.** Slack → Notion → GitHub.
GitHub에서 Notion으로 되쓰지 않는다. 유일한 예외는 신규 증빙ID 부여로,
이는 채번(採番) 책임이 정본에 있기 때문이다.

**되돌아오는 것은 판단뿐이다.** 검증 결과와 결손 목록만 Slack으로 알린다.
값을 고치는 것은 언제나 Notion(또는 PR)에서 한다.

**충돌 시 GitHub이 이긴다.** Notion과 `data/*.json`이 다르면 GitHub이 맞다고 보고
Notion을 고친다. 반대로 하지 않는다.

## 계층별 역할

| 계층 | 역할 | 하지 않는 것 |
|---|---|---|
| Slack | 현장 입력, 파일 첨부, 승인 스레드 | 데이터 보관, 집계 |
| GAS | 형식 변환, 1차 검증, 개인정보 마스킹 | 판단, 저장 |
| Notion | 검토·보완 화면, 상태 관리 | 정본 역할 |
| GitHub | 정본 보관, 법정요건 검증, 산출물 생성 | 현장 입력 |

## 구성 파일

| 경로 | 내용 |
|---|---|
| `integrations/slack/SETUP.md` | 채널 구성, Workflow 폼 설계, 앱 권한 |
| `integrations/slack/gas/Code.gs` | Slack → Notion 변환 스크립트 |
| `integrations/notion/DB-SCHEMA.md` | Notion DB 속성 정의 (evidence.schema.json 대응) |
| `integrations/notion/db-definitions.js` | DB 정의 — 선택지를 스키마·코드 마스터에서 자동 유도 |
| `integrations/notion/setup-databases.js` | DB 생성·속성 보강 (`npm run notion:setup`) |
| `scripts/sync-notion.js` | Notion → `data/evidence.json` |
| `scripts/notify-slack.js` | 검증 결과 → Slack |
| `.github/workflows/sync.yml` | 일일 동기화 + 검증 + 알림 |

## 필요한 Secrets

GitHub → Settings → Secrets and variables → Actions

| 이름 | 용도 |
|---|---|
| `NOTION_TOKEN` | Notion 내부 통합 토큰 (`ntn_...`) |
| `NOTION_EVIDENCE_DB` | 정산증빙 DB ID |
| `NOTION_PARENT_PAGE` | DB를 생성할 상위 페이지 ID (최초 구축 시에만) |
| `SLACK_WEBHOOK_URL` | 검증 결과 알림 대상 Incoming Webhook |

GAS 측 스크립트 속성(파일 → 프로젝트 설정 → 스크립트 속성)

| 이름 | 용도 |
|---|---|
| `NOTION_TOKEN` | 동일 토큰 |
| `NOTION_EVIDENCE_DB` | 동일 DB ID |
| `SLACK_BOT_TOKEN` | 파일 다운로드·스레드 회신용 (`xoxb-...`) |
| `SLACK_SIGNING_SECRET` | 요청 서명 검증 |
