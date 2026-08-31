#!/usr/bin/env node
/**
 * 검증 결과 → Slack 알림
 *
 * validate.js --json 의 출력을 받아 규칙별로 요약해 전송한다.
 * 개별 증빙ID 나열은 하지 않는다. 채널에 개인정보·거래처 정보를 흘리지 않기 위함이다.
 *
 * 환경변수: SLACK_WEBHOOK_URL
 * 사용법:   node scripts/validate.js --json | node scripts/notify-slack.js
 *          node scripts/notify-slack.js --file validation-report.json
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOOK = process.env.SLACK_WEBHOOK_URL;
const REPO = process.env.GITHUB_REPOSITORY || 'LEESUNGHO-AI/Asan-Smartcity-Settlement-System';
const RUN = process.env.GITHUB_RUN_ID;

// 규칙 → 한 줄 설명 (RULES.md와 동기화 유지)
const DESC = {
  'R-01': '기준정보 미확정 — 정산보고서 산출 차단',
  'R-02': '인정되지 않는 지급방식 (지침 §18①)',
  'R-03': '계약서 시스템 등록 15일 초과 (지침 §21④)',
  'R-04': '조달 절차 미이행 (지침 §21③·§22①)',
  'R-05': '증빙 결손 (작성지침 §5)',
  'R-06': '중요재산 미등재·보고 지연 (법 §35)',
  'R-07': '재원별 집행비율 이탈',
  'R-08': '인건비 요건 위반 (참여율·필수증빙)',
  'R-09': '준공 필수문서 결손',
  'R-10': '설계변경 타당성검토 미이행',
  'R-11': '낙찰차액 반납 대상',
  'R-12': '집행률과 물리적 진도율 괴리',
  'R-13': 'ID 중복',
  'R-20': '선금 미정산',
  'R-21': '생년월일 마스킹 누락 — 즉시 조치',
  'R-22': '예산 초과·비목 외 집행 (법 §22)',
  'SCHEMA': '스키마 위반',
};
const base = (r) => (DESC[r] ? r : r.replace(/[a-z]$/, ''));

function load() {
  const i = process.argv.indexOf('--file');
  if (i >= 0) return JSON.parse(fs.readFileSync(process.argv[i + 1], 'utf8'));
  return JSON.parse(fs.readFileSync(0, 'utf8'));
}

const rpt = load();
const errs = rpt.결과.filter((f) => f.level === 'ERROR');
const warns = rpt.결과.filter((f) => f.level === 'WARN');

function group(list) {
  const m = {};
  for (const f of list) {
    const k = base(f.rule);
    m[k] = m[k] || { n: 0, sample: f.message };
    m[k].n++;
  }
  return Object.entries(m).sort((a, b) => b[1].n - a[1].n);
}

const ok = errs.length === 0;
const blocks = [
  {
    type: 'header',
    text: { type: 'plain_text', text: ok ? '✅ 정산 원장 검증 통과' : '🚨 정산 원장 검증 실패', emoji: true },
  },
  {
    type: 'section',
    fields: [
      { type: 'mrkdwn', text: `*오류*\n${errs.length}건` },
      { type: 'mrkdwn', text: `*경고*\n${warns.length}건` },
    ],
  },
];

if (errs.length) {
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: '*해소해야 할 항목*\n' + group(errs)
        .map(([r, v]) => `• \`${r}\` ${v.n}건 — ${DESC[r] || v.sample.slice(0, 60)}`)
        .join('\n'),
    },
  });
}
if (warns.length) {
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: '*확인이 필요한 항목*\n' + group(warns).slice(0, 6)
        .map(([r, v]) => `• \`${r}\` ${v.n}건 — ${DESC[r] || v.sample.slice(0, 60)}`)
        .join('\n'),
    },
  });
}

// R-21은 개인정보 사안이므로 별도로 강조한다
if (errs.some((f) => base(f.rule) === 'R-21')) {
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: ':lock: *R-21 발생 — Notion에 마스킹되지 않은 생년월일이 있습니다.* ' +
        '즉시 정리하고, 이미 push되었다면 `SECURITY.md` 7항 절차를 따르십시오.',
    },
  });
}

blocks.push({ type: 'divider' });
blocks.push({
  type: 'context',
  elements: [{
    type: 'mrkdwn',
    text: [
      `검사 ${new Date(rpt.검사일시).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}`,
      RUN ? `<https://github.com/${REPO}/actions/runs/${RUN}|실행 로그>` : null,
      `<https://github.com/${REPO}/blob/main/rules/RULES.md|규칙 매핑표>`,
      `<https://github.com/${REPO}/blob/main/docs/OPERATIONS.md|대응 절차>`,
    ].filter(Boolean).join('  ·  '),
  }],
});

const payload = {
  text: ok ? '정산 원장 검증 통과' : `정산 원장 검증 실패 — 오류 ${errs.length}건`,
  blocks,
};

if (!HOOK) {
  console.log('SLACK_WEBHOOK_URL 미설정 — 전송할 페이로드를 출력합니다.');
  console.log(JSON.stringify(payload, null, 2));
  process.exit(0);
}

fetch(HOOK, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
}).then(async (res) => {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  console.log('Slack 알림 전송 완료');
}).catch((e) => { console.error('Slack 전송 실패:', e.message); process.exit(1); });
