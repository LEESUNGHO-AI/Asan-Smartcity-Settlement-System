# Slack 채널 구성

시스템이 참조하는 채널 ID입니다. 코드를 고칠 곳이 아니라
**스크립트 속성과 GitHub Secrets 에 넣는 값**입니다.

| 채널 | ID | 역할 | 어디에 넣나 |
|---|---|---|---|
| `#정산-증빙` | `C0BTB336U1M` | 증빙 등록 · Google Form 링크 고정 | GAS `SLACK_CHANNEL_ID` |
| `#정산-알림` | `C0BTQFR3V0E` | 검증 결과 · 수집 결과 · 등록 반려 | GAS `SLACK_ALERT_CHANNEL`<br>GitHub `SLACK_WEBHOOK_URL` |
| `#준공서류` | `C0BTNAHKDK7` | 준공서류 제출 · 확보 현황 | GAS `SLACK_COMPLETION_CHANNEL` |
| `#플랜예산` | `C0836U9HVU1` | 사업비 엑셀 원본 (기존) | `Collect.gs` 의 `수집대상` |

## 왜 알림 채널을 나누는가

`#정산-증빙` 은 사람이 자료를 올리는 곳, `#정산-알림` 은 시스템이 결과를 쏘는 곳입니다.
섞이면 담당자가 자기 글을 못 찾고 알림도 묻힙니다.

`SLACK_ALERT_CHANNEL` 을 설정하지 않으면 알림이 `#정산-증빙` 으로 떨어집니다.
**지금이 그 상태이므로 속성을 추가하셔야 제자리로 갑니다.**

## 봇 초대 — 채널마다 따로

```
/invite @아산 정산봇
```

| 채널 | 왜 필요한가 |
|---|---|
| `#플랜예산` | 엑셀 파일 목록 조회·다운로드 (D단계) |
| `#정산-알림` | 봇이 알림을 쓰기 위해 |
| `#준공서류` | 봇이 확보 현황을 쓰기 위해 |
| `#정산-증빙` | 이미 초대됨 |

## 흐름

```
#플랜예산   ──(매일 06:30 Collect.gs)──▶  GitHub source/JEIL/
#정산-증빙  ──(Google Form → Form.gs)──▶  Notion 정산증빙 DB
#준공서류   ──(수동 정리)────────────▶  Notion 준공산출물 DB
                                              │
                                    (매일 07:00 sync-notion.js)
                                              ▼
                                       GitHub data/*.json
                                              │
                                              ▼
                                    #정산-알림  ◀── 검증 결과
```
