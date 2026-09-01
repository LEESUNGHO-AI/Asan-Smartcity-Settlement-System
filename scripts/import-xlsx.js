#!/usr/bin/env node
/**
 * 사업비 xlsx → 정산 원장 변환
 *
 * Slack #플랜예산 에 매달 올라오는 「아산_강소형_사업비(new).xlsx」를 읽어
 * data/budget.json 과 data/evidence.json 을 생성한다.
 *
 *   [총괄]   시트 → budget.json      (비목·세목별 예산집행계획 = 총괄명세서 A열)
 *   [지출내역] 시트 → evidence.json   (일자별 집행내역 · 세부집행내역)
 *
 * 아무도 새로 입력하지 않는다. 이미 만들고 계신 파일이 그대로 원장이 된다.
 *
 * 사용법:
 *   node scripts/import-xlsx.js source/JEIL/사업비.xlsx
 *   node scripts/import-xlsx.js source/JEIL/사업비.xlsx --org JEIL --dry-run
 *   node scripts/import-xlsx.js --all          source/ 아래 전 기관 일괄 처리
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const ALL = argv.includes('--all');
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const codes = JSON.parse(fs.readFileSync(path.join(ROOT, 'codes/expense-categories.json'), 'utf8'));

// ── 매핑 ────────────────────────────────────────────────
// xlsx 표기 → 정산 스키마 열거값. 좌변을 바꾸지 말고 우변만 스키마에 맞춘다.
const 비목맵 = {
  '인건비': '인건비', '운영비': '운영비', '여비': '여비',
  '업무추진비': '업무추진비', '연구개발비': '연구개발비',
  '사업비배분': '민간이전', '사업비 배분': '민간이전', '민간이전': '민간이전',
  '건설비': '건설비', '유형자산': '유형자산', '무형자산': '무형자산',
};
const 세목맵 = {
  '보수': '보수', '기타직보수': '기타직보수',
  '일반수용비': '일반수용비', '공공요금 및 제세': '공공요금및제세', '공공요금및제세': '공공요금및제세',
  '임차료': '임차료', '복리후생비': '복리후생비', '일반용역비': '일반용역비',
  '국내여비': '국내여비', '국외여비': '국외여비',
  '연구개발비': '연구개발비',
  '민간이전(교부)': '민간경상보조', '민간경상보조': '민간경상보조',
  '시설비': '시설비', '자산취득비': '자산취득비', '무형자산': '무형자산',
  '사업추진비': '사업추진비',
};
/**
 * 결제방법 열은 지급수단과 증빙종류가 섞여 있다.
 * 지급수단으로 환산하되, 증빙종류인 값은 증빙유형으로도 함께 기록한다.
 * ※ '전자세금계산서'·'고지서'·'전자계산서'를 계좌이체로 보는 것은 추정이며,
 *   확정 전까지 해당 건은 검토상태를 '검토중'으로 둔다.
 */
const 결제맵 = {
  '계좌이체':       { 지급방식: '계좌이체',      증빙: ['계좌이체증'],                   확정: true },
  '카드':          { 지급방식: '보조금전용카드', 증빙: ['카드전표'],                     확정: true },
  '보조금전용카드':  { 지급방식: '보조금전용카드', 증빙: ['카드전표'],                     확정: true },
  '전자세금계산서':  { 지급방식: '계좌이체',      증빙: ['전자세금계산서', '계좌이체증'],  확정: false },
  '전자계산서':     { 지급방식: '계좌이체',      증빙: ['전자세금계산서', '계좌이체증'],  확정: false },
  '고지서':        { 지급방식: '계좌이체',      증빙: ['지출결의서', '계좌이체증'],      확정: false },
};
/** 세목·내용에서 단위사업을 추정한다. 확정할 수 없으면 SP-PMO. */
const 단위사업규칙 = [
  [/OASIS|오아시스|SPOT|스팟|도고|카라반/i, 'SP-OASIS'],
  [/이노베이션|배방|호서대|센터|스퀘어/i,     'SP-INNO'],
  [/스마트폴|가로등/i,                      'SP-POLE'],
  [/무인매장|무인점포/i,                    'SP-STORE'],
  [/유무선|네트워크|통신망|AP\b|광케이블/i,   'SP-NET'],
  [/DRT|수요응답|모빌리티|승강장/i,          'SP-DRT'],
  [/AI|관제|플랫폼|서비스\s*인프라|SDDC|GPU|서버/i, 'SP-AI'],
  [/리빙랩|델파이|연구|충남연구원|KAIST/i,    'SP-RND'],
];

const num = (v) => {
  if (v == null || v === '') return 0;
  const n = Number(String(v).replace(/[^0-9.-]/g, ''));
  return isNaN(n) ? 0 : Math.round(n);
};
function toDate(v) {
  if (!v) return null;
  if (v instanceof Date) {
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  const s = String(v).trim().replace(/[.\/]/g, '-');
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  return m ? `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}` : null;
}
/** '인건비(110)' → {명칭:'인건비', 코드:'110'} */
function splitCode(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(.+?)\s*\((\d{2,3})\)\s*$/);
  return m ? { 명칭: m[1].trim(), 코드: m[2] } : { 명칭: String(s).trim(), 코드: null };
}
function 코드찾기(비목, 세목) {
  const b = codes.비목.find((x) => x.명칭 === 비목);
  if (!b) return null;
  const s = b.세목.find((x) => x.명칭 === 세목);
  return s ? { 비목코드: b.코드, 세목코드: s.코드 } : null;
}
function 단위사업추정(text) {
  for (const [re, code] of 단위사업규칙) if (re.test(text)) return code;
  return 'SP-PMO';
}

// ══════════════════════════════════════════════════════════
// [총괄] → budget.json
// ══════════════════════════════════════════════════════════
function parseBudget(wb, warn) {
  const ws = wb.Sheets['총괄'];
  if (!ws) { warn('「총괄」 시트를 찾을 수 없습니다'); return null; }
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

  // 헤더 위치 탐색: '비목' + '보조세목'이 있는 행
  let h = -1;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const r = (rows[i] || []).map((x) => String(x || '').trim());
    if (r[0] === '비목' && r[1] && r[1].indexOf('세목') >= 0) { h = i; break; }
  }
  if (h < 0) { warn('「총괄」 시트의 헤더 행을 찾지 못했습니다'); return null; }

  const out = new Map();
  const 소계행 = (x) => /^(소\s*계|합\s*계|총\s*계)$/.test(String(x || '').trim());
  let 현재비목 = null, 현재세목 = null;
  for (let i = h + 2; i < rows.length; i++) {
    const r = rows[i] || [];
    // 소계·총계 행은 건너뛴다 (이중 합산 방지)
    if (소계행(r[0]) || 소계행(r[1]) || 소계행(r[2])) continue;

    const b = splitCode(r[0]);
    if (b && b.명칭) 현재비목 = b;
    const s = splitCode(r[1]);
    if (s && s.명칭) 현재세목 = s;
    // 산출기초만 있는 이어지는 행은 직전 세목에 합산한다
    if (!현재비목 || !현재세목) continue;
    if (!r[2] && !s) continue;

    const 비목 = 비목맵[현재비목.명칭] || 현재비목.명칭;
    const 세목 = 세목맵[현재세목.명칭] || 현재세목.명칭;
    const c = 코드찾기(비목, 세목);
    if (!c) { warn(`총괄: 코드 마스터에 없는 조합 — ${비목} / ${세목}`); continue; }

    const 예산 = num(r[3]);           // '예산' 열
    const key = `${c.비목코드}-${c.세목코드}`;
    const prev = out.get(key);
    // 산출기초 단위로 여러 행에 나뉘어 있으므로 합산한다
    if (prev) prev.예산집행계획 += 예산;
    else out.set(key, { 보조비목: 비목, 비목코드: c.비목코드, 보조세목: 세목, 세목코드: c.세목코드, 예산집행계획: 예산 });
  }
  const list = [...out.values()].filter((x) => x.예산집행계획 > 0);
  return { $schema: '../schema/budget.schema.json', 기준일: new Date().toISOString().slice(0, 10),
    근거: '사업비 xlsx 「총괄」 시트 자동 변환', 레코드: list };
}

// ══════════════════════════════════════════════════════════
// [지출내역] → evidence.json
// ══════════════════════════════════════════════════════════
function parseEvidence(wb, org, warn) {
  const ws = wb.Sheets['지출내역'];
  if (!ws) { warn('「지출내역」 시트를 찾을 수 없습니다'); return []; }
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

  let h = -1;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const r = (rows[i] || []).map((x) => String(x || '').trim());
    if (r.includes('비목') && r.includes('세목') && r.includes('지출금액')) { h = i; break; }
  }
  if (h < 0) { warn('「지출내역」 시트의 헤더 행을 찾지 못했습니다'); return []; }
  const H = rows[h].map((x) => String(x || '').trim());
  const col = (name) => H.indexOf(name);

  const C = {
    비목: col('비목'), 세목: col('세목'), 산출기초: col('산출기초'),
    결제방법: col('결제방법'), 결제일자: H.findIndex((x) => x.startsWith('결제일자')),
    이체일자: col('이체일자'), 지급처: col('지급처'), 내용: col('내용'),
    공급가액: col('공급가액'), 부가세: col('부가세'), 지출금액: col('지출금액'),
    사업연도: col('사업연도'), 비고: col('비고'),
  };

  const out = [];
  let seq = 0;
  for (let i = h + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const 금액 = num(r[C.지출금액]);
    if (!금액 && !r[C.비목]) continue;

    const 비목원 = String(r[C.비목] || '').trim();
    const 세목원 = String(r[C.세목] || '').trim();
    if (!비목원 || !세목원) { warn(`${i + 1}행: 비목·세목 누락 (금액 ${금액.toLocaleString()}원)`); continue; }

    const 비목 = 비목맵[비목원] || 비목원;
    const 세목 = 세목맵[세목원] || 세목원;
    const c = 코드찾기(비목, 세목);
    if (!c) { warn(`${i + 1}행: 코드 마스터에 없는 조합 — ${비목원} / ${세목원}`); continue; }

    const 결제원 = String(r[C.결제방법] || '').trim();
    const 결제 = 결제맵[결제원] || { 지급방식: '기타', 증빙: [], 확정: false };
    if (!결제맵[결제원] && 결제원) warn(`${i + 1}행: 알 수 없는 결제방법 — ${결제원}`);

    const 일자 = toDate(r[C.이체일자]) || toDate(r[C.결제일자]);
    if (!일자) { warn(`${i + 1}행: 집행일자를 읽을 수 없음`); continue; }

    const 내용 = String(r[C.내용] || '').trim();
    const 산출 = String(r[C.산출기초] || '').trim();
    const 목적 = [산출, 내용].filter(Boolean).join(' — ') || 세목;

    const rec = {
      증빙ID: `EV-${일자.slice(0, 4)}-${String(++seq).padStart(5, '0')}`,
      기관: org,
      단위사업: 단위사업추정(`${산출} ${내용} ${세목}`),
      보조비목: 비목, 비목코드: c.비목코드,
      보조세목: 세목, 세목코드: c.세목코드,
      재원: '국비',                       // xlsx에 재원 열이 없음 → 확정 전까지 국비로 두고 R-07이 잡게 한다
      계약ID: null,
      지급처: { 구분: '사업자', 명칭: String(r[C.지급처] || '').trim() || '(미기재)' },
      집행일자: 일자,
      집행금액: 금액,
      사용목적: 목적,
      지급방식: 결제.지급방식,
      증빙유형: 결제.증빙,
      검토상태: 결제.확정 ? '제출완료' : '검토중',
      감사추적: { 등록일시: new Date().toISOString(), 등록자: '사업비 xlsx 자동변환', 출처: '시스템연계' },
    };
    const 공급 = num(r[C.공급가액]); const 부가 = num(r[C.부가세]);
    if (공급) rec.공급가액 = 공급;
    if (부가) rec.부가세 = 부가;
    if (세목 === '일반수용비' && /회의/.test(산출 + 내용)) rec.세부구분 = '회의비';
    else if (세목 === '일반수용비') rec.세부구분 = '일반수용비';
    if (/선금|선급/.test(산출 + 내용)) rec.선금여부 = true;
    if (비목 === '인건비') {
      rec.지급처 = { 구분: '개인', 명칭: String(r[C.지급처] || '').trim() || '(미기재)' };
      rec.귀속월 = 일자.slice(0, 7);
      rec.검토상태 = '보완필요';
      rec.보완사유 = '인건비: 생년월일(마스킹)·참여율·필수증빙 5종 보완 필요';
    }
    const 비고 = String(r[C.비고] || '').trim();
    if (비고) rec.비고 = 비고;
    out.push(rec);
  }
  return out;
}

// ══════════════════════════════════════════════════════════
// 실행
// ══════════════════════════════════════════════════════════
function run(file, org) {
  const warnings = [];
  const warn = (m) => warnings.push(m);
  console.log(`\n■ ${path.basename(file)}  (기관: ${org})`);

  const wb = XLSX.readFile(file, { cellDates: true });
  const budget = parseBudget(wb, warn);
  const evidence = parseEvidence(wb, org, warn);

  if (budget) {
    const t = budget.레코드.reduce((s, x) => s + x.예산집행계획, 0);
    console.log(`  예산   ${budget.레코드.length}개 세목 · ${t.toLocaleString('ko-KR')}원`);
  }
  const 합계 = evidence.reduce((s, e) => s + e.집행금액, 0);
  console.log(`  집행   ${evidence.length}건 · ${합계.toLocaleString('ko-KR')}원`);

  const 상태 = {};
  for (const e of evidence) 상태[e.검토상태] = (상태[e.검토상태] || 0) + 1;
  console.log(`  상태   ${Object.entries(상태).map(([k, v]) => `${k} ${v}건`).join(' · ')}`);

  if (warnings.length) {
    console.log(`  경고   ${warnings.length}건`);
    const uniq = [...new Set(warnings.map((w) => w.replace(/^\d+행: /, '')))];
    uniq.slice(0, 12).forEach((w) => console.log(`         - ${w}`));
    if (uniq.length > 12) console.log(`         ... 외 ${uniq.length - 12}종`);
  }
  return { budget, evidence, warnings };
}

const targets = [];
if (ALL) {
  const dir = path.join(ROOT, 'source');
  if (!fs.existsSync(dir)) { console.error('source/ 폴더가 없습니다.'); process.exit(1); }
  for (const org of fs.readdirSync(dir)) {
    const sub = path.join(dir, org);
    if (!fs.statSync(sub).isDirectory()) continue;
    for (const f of fs.readdirSync(sub)) {
      if (/\.xlsx?$/i.test(f) && !f.startsWith('~$')) targets.push({ file: path.join(sub, f), org });
    }
  }
} else {
  const f = argv.find((a) => /\.xlsx?$/i.test(a));
  if (!f) { console.error('엑셀 파일 경로를 지정하십시오.'); process.exit(1); }
  targets.push({ file: path.resolve(f), org: argOf('--org', 'JEIL') });
}

let 전체증빙 = [];
let 예산 = null;
for (const t of targets) {
  const r = run(t.file, t.org);
  전체증빙 = 전체증빙.concat(r.evidence);
  if (r.budget && (!예산 || t.org === 'JEIL')) 예산 = r.budget;
}

전체증빙.sort((a, b) => a.집행일자.localeCompare(b.집행일자) || a.증빙ID.localeCompare(b.증빙ID));
// 기관 통합 시 증빙ID 재부여
const cnt = {};
for (const e of 전체증빙) {
  const y = e.집행일자.slice(0, 4);
  cnt[y] = (cnt[y] || 0) + 1;
  e.증빙ID = `EV-${y}-${String(cnt[y]).padStart(5, '0')}`;
}

console.log('\n─────────────────────────────────────────────');
console.log(` 총 ${전체증빙.length}건 · ${전체증빙.reduce((s, e) => s + e.집행금액, 0).toLocaleString('ko-KR')}원`);

if (DRY) { console.log(' --dry-run: 파일을 기록하지 않았습니다.'); process.exit(0); }

if (예산) fs.writeFileSync(path.join(ROOT, 'data/budget.json'), JSON.stringify(예산, null, 2) + '\n');
fs.writeFileSync(path.join(ROOT, 'data/evidence.json'),
  JSON.stringify({ $schema: '../schema/evidence.schema.json', 갱신일시: new Date().toISOString(), 레코드: 전체증빙 }, null, 2) + '\n');
console.log(' data/budget.json · data/evidence.json 기록 완료');
