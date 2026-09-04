#!/usr/bin/env node
/**
 * 공개 대시보드용 집계 데이터 생성
 *
 * data/*.json(원장)에서 집계값만 뽑아 dashboard/data.json 을 만든다.
 * 원장에는 성명·생년월일·사업자등록번호·거래처별 금액이 들어 있으나,
 * 이 파일에는 **한 건도 나가지 않는다.** 공개 저장소로 배포되기 때문이다.
 *
 * 나가는 것 : 비목별 예산·집행·집행률, 재원별·기관별 집계, 검증 지적 건수, 진척
 * 안 나가는 것 : 개인 성명, 생년월일, 사업자등록번호, 거래처별 개별 금액, 증빙 상세
 *
 * 사용법: node scripts/publish-dashboard.js
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

const base = read('data/baseline.json');
const budget = read('data/budget.json').레코드;
const evidence = read('data/evidence.json').레코드;
const contracts = read('data/contracts.json').레코드;
const assets = read('data/assets.json').레코드;
const completion = read('data/completion.json').레코드;
const codes = read('codes/expense-categories.json');
const orgs = read('codes/organizations.json').코드;

// ── 검증 결과 ────────────────────────────────────────────
let 검증 = { 오류: 0, 경고: 0, 항목: [] };
try {
  // validate.js 는 오류가 있으면 종료코드 1을 낸다. 그것이 정상 동작이므로
  // 예외로 처리하지 않고 stdout 을 그대로 읽는다.
  let raw;
  try {
    raw = execSync('node scripts/validate.js --json', { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    raw = String(e.stdout || '');
  }
  const r = JSON.parse(raw.slice(raw.indexOf('{')));
  const 묶음 = {};
  for (const f of r.결과) {
    const key = f.rule.replace(/[a-z]$/, '');
    묶음[key] = 묶음[key] || { 규칙: key, 수준: f.level, 건수: 0, 근거: f.law, 요약: '' };
    묶음[key].건수++;
    if (f.level === 'ERROR') 묶음[key].수준 = 'ERROR';
  }
  const 설명 = {
    'R-01': '기준정보 미확정 — 정산보고서 산출 차단',
    'R-02': '인정되지 않는 지급방식',
    'R-03': '계약서 시스템 등록 15일 초과',
    'R-04': '조달 절차 미이행 또는 계약 미연결',
    'R-05': '증빙 결손',
    'R-06': '중요재산 미등재·보고 지연',
    'R-07': '재원별 집행비율 이탈',
    'R-08': '인건비 요건 위반',
    'R-09': '준공 필수문서 결손',
    'R-10': '설계변경 타당성검토 미이행',
    'R-11': '낙찰차액 반납 대상',
    'R-12': '집행률과 물리적 진도율 괴리',
    'R-13': 'ID 중복',
    'R-20': '선금 미정산',
    'R-21': '생년월일 마스킹 누락',
    'R-22': '예산 초과·비목 외 집행',
    'R-23': '환불·정정(음수 집행)',
    'SCHEMA': '데이터 구조 위반',
  };
  검증 = {
    오류: r.오류, 경고: r.경고,
    항목: Object.values(묶음)
      .map((x) => ({ ...x, 요약: 설명[x.규칙] || '' }))
      .sort((a, b) => (a.수준 === b.수준 ? b.건수 - a.건수 : a.수준 === 'ERROR' ? -1 : 1)),
  };
} catch (err) {
  console.error('검증 결과를 읽지 못했습니다:', err.message);
}

// ── 비목별 집계 ─────────────────────────────────────────
const 순서 = codes.비목.map((b) => b.코드);
const 집행 = {};
for (const e of evidence) {
  const k = `${e.비목코드}-${e.세목코드}`;
  집행[k] = (집행[k] || 0) + e.집행금액;
}
const 비목별 = [...budget]
  .sort((a, b) => (순서.indexOf(a.비목코드) - 순서.indexOf(b.비목코드)) || a.세목코드.localeCompare(b.세목코드))
  .map((b) => {
    const v = 집행[`${b.비목코드}-${b.세목코드}`] || 0;
    return {
      비목: b.보조비목, 비목코드: b.비목코드,
      세목: b.보조세목, 세목코드: b.세목코드,
      예산: b.예산집행계획, 집행: v, 잔액: b.예산집행계획 - v,
      집행률: b.예산집행계획 > 0 ? v / b.예산집행계획 : 0,
    };
  });

// ── 재원별 ─────────────────────────────────────────────
const 재원별 = {};
for (const e of evidence) 재원별[e.재원] = (재원별[e.재원] || 0) + e.집행금액;

// ── 기관별 (건수·금액만) ─────────────────────────────────
const 기관집계 = {};
for (const e of evidence) {
  const o = 기관집계[e.기관] = 기관집계[e.기관] || { 건수: 0, 금액: 0 };
  o.건수++; o.금액 += e.집행금액;
}
const 기관별 = orgs.map((o) => ({
  코드: o.코드, 명칭: o.명칭, 구분: o.구분,
  건수: (기관집계[o.코드] || {}).건수 || 0,
  금액: (기관집계[o.코드] || {}).금액 || 0,
})).filter((o) => o.건수 > 0 || o.코드 === 'JEIL');

// ── 증빙 상태 ───────────────────────────────────────────
const 상태별 = {};
for (const e of evidence) 상태별[e.검토상태] = (상태별[e.검토상태] || 0) + 1;

// ── 준공 ───────────────────────────────────────────────
const 준공 = completion.map((c) => {
  const 필수 = c.문서.filter((d) => d.필수여부 !== false);
  const 확보 = 필수.filter((d) => ['제출완료', '확정'].includes(d.상태)).length;
  return { 명칭: c.명칭, 유형: c.유형, 수행사: c.수행사 || null, 상태: c.상태,
           진도율: c.물리적진도율 ?? null, 문서확보: 확보, 문서필요: 필수.length };
});

// ── 산출물 목록 ───────────────────────────────────────
// output/ 의 파일을 대시보드에서 바로 받을 수 있도록 목록을 만든다.
const 분류 = (n) =>
  n.startsWith('아산_정산_종합내역') ? '종합 내역 (엑셀)'
  : n.startsWith('[별지1호]') ? '법정서식 · 실적보고서'
  : n.startsWith('[별지2호]') ? '법정서식 · 정산보고서'
  : n.startsWith('[별지3호]') ? '법정서식 · 총괄명세서'
  : n.startsWith('[별지4호]') ? '법정서식 · 일자별 집행명세서'
  : n.startsWith('보조사업_집행결과') ? '집행결과 제출 양식(사업 자체 양식)'
  : n.startsWith('준공서류_확보현황') ? '준공서류 확보 현황'
  : n.startsWith('준공검사조서') ? '준공검사조서'
  : n.startsWith('검수조서') ? '검수조서'
  : n.startsWith('인계인수서') ? '시설물 인계·인수서'
  : '기타';
let 산출물 = [];
try {
  const dir = path.join(ROOT, 'output');
  산출물 = fs.readdirSync(dir)
    .filter((f) => /\.(docx?|xlsx|pdf)$/i.test(f) && !f.startsWith('~$'))
    .map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { 파일: f, 종류: 분류(f), 크기: st.size, 생성: st.mtime.toISOString().slice(0, 10) };
    })
    .sort((a, b) => (a.종류 === b.종류 ? a.파일.localeCompare(b.파일) : a.종류.localeCompare(b.종류)));
} catch (e) { 산출물 = []; }

// ── D-day ──────────────────────────────────────────────
const 종료일 = base.사업.사업기간.종료일;
const dday = Math.ceil((new Date(종료일) - new Date()) / 86400000);

const 총예산 = 비목별.reduce((s, x) => s + x.예산, 0);
const 총집행 = 비목별.reduce((s, x) => s + x.집행, 0);

// 데이터 출처 집계 — 무엇이 자동이고 무엇이 수동인지
const 출처집계 = (list) => {
  const c = {};
  for (const r of list) { const o = (r.감사추적 || {}).출처 || '?'; c[o] = (c[o] || 0) + 1; }
  return c;
};
const 출처요약 = {
  정산증빙: 출처집계(evidence),
  계약: 출처집계(contracts),
  중요재산: 출처집계(assets),
  준공: 출처집계(completion),
};

const out = {
  생성일시: new Date().toISOString(),
  사업: {
    사업명: base.사업.사업명,
    세부사업명: base.사업.세부사업명,
    기간: { 개시: base.사업.사업기간.개시일, 종료: 종료일, 확정: base.사업.사업기간.confirmed },
    총사업비: base.사업.총사업비.금액,
    총사업비확정: base.사업.총사업비.confirmed,
    dday,
  },
  집행: { 예산: 총예산, 집행: 총집행, 잔액: 총예산 - 총집행, 집행률: 총예산 > 0 ? 총집행 / 총예산 : 0 },
  비목별, 재원별, 기관별,
  증빙: { 총건수: evidence.length, 상태별 },
  계약: { 건수: contracts.length, 계약금액: contracts.reduce((s, c) => s + (c.계약금액 || 0), 0), 낙찰차액: contracts.reduce((s, c) => s + (c.낙찰차액 || 0), 0) },
  자산: {
    건수: assets.length,
    취득가액: assets.reduce((s, a) => s + (a.취득가액 || 0), 0),
    미보고: assets.filter((a) => !a.보고 || !a.보고.취득보고일).length,
    유형별: (() => {
      const m = {};
      for (const a of assets) {
        const k = /무형자산/.test(a.비고 || '') ? '무형자산(SW)' : '기계·장비';
        m[k] = m[k] || { 건수: 0, 금액: 0 };
        m[k].건수++; m[k].금액 += a.취득가액 || 0;
      }
      return m;
    })(),
    상위: [...assets].sort((a, b) => (b.취득가액 || 0) - (a.취득가액 || 0)).slice(0, 12)
      .map((a) => ({ 재산명: a.재산명, 구분: /무형자산/.test(a.비고 || '') ? '무형자산' : '기계·장비',
        취득가액: a.취득가액, 취득일: a.취득일, 처분제한: (a.처분제한 || {}).기간_년, 보고: !!(a.보고 && a.보고.취득보고일) })),
  },
  준공,
  산출물,
  출처요약,
  검증,
  미확정사항: (base.미확정사항 || []).map((x) => ({ 항목: x.항목, 확인처: x.확인처, 중요도: x.중요도, 상태: x.상태, 질의번호: x.질의번호 || null })),
};

// 개인정보 유출 방어 — 집계 데이터에 금지 키가 섞이면 즉시 중단한다
const 금지 = ['생년월일', '사업자등록번호', '지급처', '성명', '참여율'];
const 직렬 = JSON.stringify(out);
for (const k of 금지) {
  if (직렬.indexOf(`"${k}"`) >= 0) {
    console.error(`중단: 집계 데이터에 「${k}」가 포함되어 있습니다. 공개 배포할 수 없습니다.`);
    process.exit(1);
  }
}

fs.mkdirSync(path.join(ROOT, 'dashboard'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'dashboard/data.json'), 직렬.length > 0 ? JSON.stringify(out, null, 2) + '\n' : '');

console.log('dashboard/data.json 생성 완료');
console.log(`  비목 ${비목별.length}개 · 증빙 ${evidence.length}건 · 검증 오류 ${검증.오류} 경고 ${검증.경고}`);
console.log(`  집행률 ${(out.집행.집행률 * 100).toFixed(1)}% (${총집행.toLocaleString('ko-KR')} / ${총예산.toLocaleString('ko-KR')})`);
console.log('  개인정보 검사 통과 — 성명·생년월일·사업자등록번호 미포함');
