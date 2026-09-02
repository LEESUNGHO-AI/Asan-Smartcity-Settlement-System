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
 *   node scripts/import-xlsx.js --all --mask   개인 성명을 가려서 기록 (공개 저장소용)
 */

const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const ALL = argv.includes('--all');
// 공개 저장소에서는 반드시 켜야 한다. 개인 성명이 원장에 그대로 남지 않도록 가린다.
const MASK = argv.includes('--mask');
const argOf = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const codes = JSON.parse(fs.readFileSync(path.join(ROOT, 'codes/expense-categories.json'), 'utf8'));

// ── 매핑 ────────────────────────────────────────────────
// 브라우저(dashboard/parse.js)와 같은 파일을 읽는다. 한쪽만 고치면 결과가 갈라진다.
const M = JSON.parse(fs.readFileSync(path.join(ROOT, 'codes/xlsx-mapping.json'), 'utf8'));
const 비목맵 = M.비목맵, 세목맵 = M.세목맵, 결제맵 = M.결제맵;
const 단위사업규칙 = M.단위사업규칙.map((r) => [new RegExp(r.패턴, 'i'), r.코드]);
const 법인어 = new RegExp(M.법인어, 'i');
const 개인지급어 = new RegExp(M.개인지급어);

// ── 마스터 결합 ─────────────────────────────────────────
// 엑셀에 없는 항목(생년월일·참여율·사업자등록번호)을 명부에서 붙인다.
// 엑셀을 고치지 않고도 4-1 세부집행내역을 채울 수 있게 하기 위함이다.
const STAFF = (function () {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'codes/staff.json'), 'utf8'));
    const m = {};
    (j.인력 || []).forEach((x) => { m[x.성명] = { 생년월일: x.생년월일, 참여율: x.기본참여율, 구분: x.구분 }; });
    ((j.외부인력 || {}).명단 || []).forEach((x) => { if (!m[x.성명]) m[x.성명] = { 생년월일: x.생년월일 }; });
    return m;
  } catch (e) { return {}; }
})();
const VENDOR = (function () {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(ROOT, 'codes/vendors.json'), 'utf8'));
    const m = {};
    (j.거래처 || []).forEach((x) => { if (x.사업자등록번호) m[x.상호] = x.사업자등록번호; });
    return m;
  } catch (e) { return {}; }
})();

/**
 * 개인 성명 가리기. 급여·여비·평가위원 수당은 지급처가 개인 실명이다.
 * 이성호 → 이*호 / 임혁 → 임*.  법인·상호는 상거래 정보이므로 가리지 않는다.
 */
function maskName(name, 비목, 목적) {
  if (!MASK) return name;
  const n = String(name || '').trim();
  if (!n || 법인어.test(n)) return n;
  const 개인문맥 = 비목 === '인건비' || 비목 === '여비' || 개인지급어.test(목적 || '');
  if (!개인문맥) return n;
  if (!/^[가-힣]{2,4}$/.test(n)) return n;
  if (n.length === 2) return n[0] + '*';
  return n[0] + '*'.repeat(n.length - 2) + n[n.length - 1];
}

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
/** 원본 성명으로 명부를 조회한 뒤, 기록은 마스킹된 이름으로 남긴다. */
function 지급처만들기(원본, 비목, 목적, 개인강제) {
  const 이름 = 원본 || '(미기재)';
  const st = STAFF[이름];
  const 개인 = 개인강제 || !!st;
  const out = { 구분: 개인 ? '개인' : '사업자', 명칭: maskName(이름, 비목, 목적) || '(미기재)' };
  if (개인) {
    if (st && st.생년월일) out.생년월일 = st.생년월일;
    if (st && typeof st.참여율 === 'number') out.참여율 = st.참여율;
  } else if (VENDOR[이름]) {
    out.사업자등록번호 = VENDOR[이름];
  }
  return out;
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
    재원: col('재원') >= 0 ? col('재원') : col('재원구분'),
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
      // 엑셀에 재원 열이 있으면 읽고, 없으면 '미구분'으로 남긴다. 지어내지 않는다.
      재원: (C.재원 >= 0 && String(r[C.재원] || '').trim()) || '미구분',
      계약ID: null,
      지급처: 지급처만들기(String(r[C.지급처] || '').trim(), 비목, 목적),
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
      rec.지급처 = 지급처만들기(String(r[C.지급처] || '').trim(), 비목, 목적, true);
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
if (MASK) {
  const 가림 = 전체증빙.filter((e) => /\*/.test(e.지급처.명칭)).length;
  console.log(` 개인 성명 가림 ${가림}건 — 공개 저장소 커밋 가능`);
} else {
  console.log(' ⚠ --mask 미적용: 개인 실명이 그대로 기록됩니다. 비공개 저장소에서만 사용하십시오.');
}
console.log(` 총 ${전체증빙.length}건 · ${전체증빙.reduce((s, e) => s + e.집행금액, 0).toLocaleString('ko-KR')}원`);

if (DRY) { console.log(' --dry-run: 파일을 기록하지 않았습니다.'); process.exit(0); }

if (예산) fs.writeFileSync(path.join(ROOT, 'data/budget.json'), JSON.stringify(예산, null, 2) + '\n');
fs.writeFileSync(path.join(ROOT, 'data/evidence.json'),
  JSON.stringify({ $schema: '../schema/evidence.schema.json', 갱신일시: new Date().toISOString(), 레코드: 전체증빙 }, null, 2) + '\n');
console.log(' data/budget.json · data/evidence.json 기록 완료');
