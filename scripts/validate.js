#!/usr/bin/env node
/**
 * 아산시 강소형 스마트시티 정산시스템 — 원장 검증기
 *
 * 2단계로 검증한다.
 *   1) 스키마 검증  : data/*.json 이 schema/*.schema.json 을 만족하는가
 *   2) 규칙 검증    : 보조금법령·통합관리지침상 요건을 위반하지 않는가 (rules/RULES.md)
 *
 * 종료코드: 0 = 통과(경고 포함) / 1 = 오류 존재 → GitHub Actions 실패
 * 옵션: --strict  경고도 오류로 취급
 */

const fs = require('fs');
const path = require('path');
const Ajv = require('ajv/dist/2020');
const addFormats = require('ajv-formats');

const ROOT = path.resolve(__dirname, '..');
const STRICT = process.argv.includes('--strict');
const JSON_OUT = process.argv.includes('--json');

const findings = []; // {level, rule, target, message, law}

function report(level, rule, target, message, law) {
  findings.push({ level, rule, target, message, law });
}
const error = (...a) => report('ERROR', ...a);
const warn = (...a) => report('WARN', ...a);

const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const days = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);
const won = (n) => (n ?? 0).toLocaleString('ko-KR') + '원';

// ─────────────────────────────────────────────────────────────
// 1. 스키마 검증
// ─────────────────────────────────────────────────────────────
function validateSchemas() {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);

  const schemaDir = path.join(ROOT, 'schema');
  const schemas = fs.readdirSync(schemaDir).filter((f) => f.endsWith('.schema.json'));

  // $id 의 파일명 부분을 키로 등록해 상대 $ref("common.schema.json#/$defs/…") 를 해석
  for (const f of schemas) {
    const s = JSON.parse(fs.readFileSync(path.join(schemaDir, f), 'utf8'));
    ajv.addSchema(s, `https://leesungho-ai.github.io/asan-sms/schema/${f}`);
  }

  const pairs = [
    ['data/baseline.json', 'baseline.schema.json'],
    ['data/evidence.json', 'evidence.schema.json'],
    ['data/contracts.json', 'contracts.schema.json'],
    ['data/assets.json', 'assets.schema.json'],
    ['data/completion.json', 'completion.schema.json'],
  ];

  for (const [dataFile, schemaFile] of pairs) {
    const validate = ajv.getSchema(`https://leesungho-ai.github.io/asan-sms/schema/${schemaFile}`);
    const data = read(dataFile);
    if (!validate(data)) {
      for (const e of validate.errors) {
        error('SCHEMA', `${dataFile}${e.instancePath}`, `${e.message}${e.params ? ' ' + JSON.stringify(e.params) : ''}`, schemaFile);
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 2. 규칙 검증
// ─────────────────────────────────────────────────────────────
function validateRules() {
  const base = read('data/baseline.json');
  const ev = read('data/evidence.json').레코드;
  const bg = read('data/budget.json').레코드;
  const ct = read('data/contracts.json').레코드;
  const as = read('data/assets.json').레코드;
  const cp = read('data/completion.json').레코드;
  const B = base.정산기준;
  const ctById = Object.fromEntries(ct.map((c) => [c.계약ID, c]));

  // ── R-01 기준정보 미확정 ─────────────────────────────
  const unconfirmed = [];
  if (base.사업.사업기간.confirmed === false) unconfirmed.push('사업기간');
  if (base.사업.준공기준시점?.confirmed === false) unconfirmed.push('준공기준시점');
  if (base.사업.총사업비.confirmed === false) unconfirmed.push('총사업비');
  for (const o of base.기관) {
    if (o.회계감사대상?.confirmed === false) unconfirmed.push(`${o.코드}.회계감사대상`);
  }
  if (unconfirmed.length) {
    error('R-01', 'baseline', `기준정보 미확정: ${unconfirmed.join(', ')} — 정산보고서 산출 차단`, '협약서·교부결정통지서');
  }
  const pending = (base.미확정사항 || []).filter((x) => x.상태 !== '회신완료');
  if (pending.length) {
    warn('R-01', 'baseline.미확정사항', `미회신 ${pending.length}건 (최상 ${pending.filter((x) => x.중요도 === '최상').length}건)`, '협약서·국토부 회신');
  }

  // ── R-02 지급방법 위반 ───────────────────────────────
  for (const e of ev) {
    if (!B.인정지급방법.includes(e.지급방식)) {
      error('R-02', e.증빙ID, `지급방법 '${e.지급방식}' 은 인정되지 않음 (${won(e.집행금액)}) — 불인정 위험`, '통합관리지침 §18①');
    }
    if ((e.증빙유형 || []).includes('세금계산서') && !(e.증빙유형 || []).includes('전자세금계산서')) {
      warn('R-02b', e.증빙ID, '전자세금계산서 여부 확인 필요', '통합관리지침 §18②');
    }
  }

  // ── R-03 계약서 시스템 등록 지연 ─────────────────────
  for (const c of ct) {
    if (!c.시스템등록일) {
      warn('R-03', c.계약ID, '보조금시스템 계약서 등록일 미기재', '통합관리지침 §21④');
      continue;
    }
    const d = days(c.계약일, c.시스템등록일);
    if (d > base.기한.계약서_시스템등록_일) {
      error('R-03', c.계약ID, `계약서 등록 지연 ${d}일 (기준 ${base.기한.계약서_시스템등록_일}일)`, '통합관리지침 §21④');
    }
  }

  // ── R-04 계약방법 임계액 / 증빙-계약 연결 ────────────
  const 임계 = (c) => {
    if (c.계약유형 === '용역' || c.계약유형 === '물품') return B.조달_물품용역_초과액;
    if (c.계약유형 === '공사') return B.조달_건설공사_초과액;
    if (['전문공사', '전기공사', '정보통신공사', '소방공사'].includes(c.계약유형)) return B.조달_전문공사_초과액;
    return B.조달_기타공사_초과액;
  };
  for (const c of ct) {
    if (c.추정가격 > 임계(c) && (!c.조달?.위탁구분 || c.조달.위탁구분 === '해당없음')) {
      error('R-04', c.계약ID, `추정가격 ${won(c.추정가격)} 이 임계액 ${won(임계(c))} 초과 — 조달청·지자체 위탁 또는 나라장터 이용 의무`, '통합관리지침 §21③');
    }
    const 검토임계 = ['전문공사', '전기공사', '정보통신공사', '소방공사'].includes(c.계약유형)
      ? B.조달청검토_특수공사_이상액 : B.조달청검토_공사_이상액;
    const isWork = c.계약유형 !== '용역' && c.계약유형 !== '물품' && c.계약유형 !== '기타';
    if (isWork && c.추정가격 >= 검토임계 && !c.조달?.설계적정성검토 && !c.조달?.예외사유) {
      error('R-04b', c.계약ID, `추정가격 ${won(c.추정가격)} — 조달청 설계적정성 검토 대상이나 미이행·예외사유 미기재`, '통합관리지침 §22①');
    }
  }
  for (const e of ev) {
    const 계약성비목 = ['건설비', '유형자산', '무형자산', '연구개발비', '민간이전'].includes(e.보조비목);
    if (계약성비목 && !e.계약ID) {
      warn('R-04c', e.증빙ID, `${e.보조비목} 지출이나 계약ID 미연결 (${won(e.집행금액)})`, '통합관리지침 §21');
    }
    if (e.계약ID && !ctById[e.계약ID]) {
      error('R-04d', e.증빙ID, `참조 계약ID '${e.계약ID}' 가 계약대장에 없음`, '참조무결성');
    }
  }

  // ── R-05 증빙 연결성 ─────────────────────────────────
  const 지급증빙 = ['계좌이체증', '카드전표'];
  const 세금증빙 = ['세금계산서', '전자세금계산서'];
  for (const e of ev) {
    const t = e.증빙유형 || [];
    if (!t.some((x) => 지급증빙.includes(x))) {
      error('R-05', e.증빙ID, '지급 증빙(계좌이체증·카드전표) 미확보', '작성지침 §5');
    }
    if (e.부가세 > 0 && !t.some((x) => 세금증빙.includes(x))) {
      error('R-05b', e.증빙ID, '부가세 계상 건이나 세금계산서 미확보', '작성지침 §5');
    }
    if (e.공급가액 != null && e.부가세 != null && e.공급가액 + e.부가세 !== e.집행금액) {
      error('R-05c', e.증빙ID, `공급가액+부가세 ≠ 집행금액 (${won(e.공급가액)} + ${won(e.부가세)} ≠ ${won(e.집행금액)})`, '산식오류');
    }
    if (!e.사용목적 || e.사용목적.trim().length < 5) {
      warn('R-05d', e.증빙ID, '사용목적이 지나치게 간략 — 사업 관련성 소명 불가', '작성지침 §5');
    }
  }

  // ── R-06 중요재산 누락 ───────────────────────────────
  const assetById = Object.fromEntries(as.map((a) => [a.자산ID, a]));
  for (const e of ev) {
    if (['유형자산', '무형자산'].includes(e.보조비목) && e.집행금액 > B.중요재산_하한액) {
      if (!e.자산ID) {
        error('R-06', e.증빙ID, `취득가액 ${won(e.집행금액)} (하한 ${won(B.중요재산_하한액)} 초과) 이나 중요재산 미등재`, '보조금법 §35 / 지침 §46');
      } else if (!assetById[e.자산ID]) {
        error('R-06b', e.증빙ID, `참조 자산ID '${e.자산ID}' 가 중요재산대장에 없음`, '참조무결성');
      }
    }
  }
  for (const a of as) {
    if (!a.보고?.취득보고일) {
      error('R-06c', a.자산ID, '취득보고일 미기재 — 취득 후 15일 이내 보고 의무', '통합관리지침 §46①');
    } else {
      const d = days(a.취득일, a.보고.취득보고일);
      if (d > base.기한.중요재산_취득보고_일) {
        error('R-06d', a.자산ID, `중요재산 취득보고 지연 ${d}일 (기준 ${base.기한.중요재산_취득보고_일}일)`, '통합관리지침 §46①');
      }
    }
    const 기대기간 = ['부동산', '선박', '부표·부잔교·부선거', '항공기'].includes(a.재산구분) ? 10 : 5;
    if (a.처분제한?.기간_년 && a.처분제한.기간_년 !== 기대기간) {
      error('R-06e', a.자산ID, `처분제한기간 ${a.처분제한.기간_년}년 — ${a.재산구분}은 ${기대기간}년`, '통합관리지침 §46③');
    }
    if (a.재산구분 === '부동산' && !a.처분제한?.부기등기?.필요여부) {
      warn('R-06f', a.자산ID, '부동산 — 부기등기 필요 여부 미판정', '보조금법 §35의2');
    }
  }

  // ── R-07 재원비율 이탈 ───────────────────────────────
  const 확정 = ev.filter((e) => e.검토상태 === '확정');
  const 재원합 = {};
  let 총합 = 0;
  for (const e of 확정) {
    재원합[e.재원] = (재원합[e.재원] || 0) + e.집행금액;
    총합 += e.집행금액;
  }
  if (총합 > 0) {
    for (const [원, 비율] of Object.entries(base.재원비율)) {
      if (원 === '허용오차_퍼센트포인트') continue;
      if (비율 === 0) continue;
      const 실제 = ((재원합[원] || 0) / 총합) * 100;
      const 이탈 = Math.abs(실제 - 비율);
      if (이탈 > base.재원비율.허용오차_퍼센트포인트) {
        warn('R-07', `재원:${원}`, `집행비율 ${실제.toFixed(1)}% vs 협약 ${비율}% (이탈 ${이탈.toFixed(1)}%p)`, '작성지침 §4②');
      }
    }
  }

  // ── R-08 인건비 요건 ─────────────────────────────────
  const 인건비필수 = ['급여대장', '계좌이체증'];
  const 참여율 = {};
  for (const e of ev) {
    if (e.보조비목 !== '인건비') continue;
    if (e.지급처?.구분 !== '개인' || e.지급처.참여율 == null) {
      error('R-08', e.증빙ID, '인건비 지출이나 지급처가 개인(성명·참여율)으로 기재되지 않음', '작성지침 §5');
      continue;
    }
    const 결손 = 인건비필수.filter((t) => !(e.증빙유형 || []).includes(t));
    if (결손.length) error('R-08b', e.증빙ID, `인건비 필수증빙 결손: ${결손.join(', ')}`, '작성지침 §5');
    if (e.승인인력여부 === false) {
      error('R-08c', e.증빙ID, `미승인 인력 '${e.지급처.명칭}' 인건비 계상`, '보조금법 §22');
    }
    if (!e.귀속월) { warn('R-08e', e.증빙ID, '귀속월 미기재 — 참여율 합계 검사 불가', '작성지침 §5'); continue; }
    const key = `${e.지급처.명칭}|${e.귀속월}`;
    참여율[key] = Math.max(참여율[key] || 0, e.지급처.참여율);
  }
  for (const [key, v] of Object.entries(참여율)) {
    if (v > 100) error('R-08d', key.replace('|', ' / '), `참여율 ${v}% — 100% 초과`, '작성지침 §5');
  }

  // ── R-21 개인정보 노출 ───────────────────────────────
  for (const e of ev) {
    const d = e.지급처?.생년월일;
    if (d && !/\*\*$/.test(d)) {
      error('R-21', e.증빙ID, `생년월일 '${d}' 마스킹 누락 — 공개 리포지토리 커밋 금지`, '개인정보 보호법 §29');
    }
  }

  // ── R-20 선금 미정산 ─────────────────────────────────
  const 선금 = ev.filter((e) => e.선금여부 === true);
  const 선금액 = 선금.reduce((s2, e) => s2 + e.집행금액, 0);
  if (선금액 > 0) {
    warn('R-20', `선금 ${선금.length}건`, `선금 집행액 ${won(선금액)} — 준공·기성 정산 및 선금보증 회수 확인 필요`, '통합관리지침 §18 / 계약예규');
  }

  // ── R-22 예산 초과집행 ───────────────────────────────
  const 예산 = Object.fromEntries(bg.map((b) => [`${b.비목코드}-${b.세목코드}`, b]));
  const 집행 = {};
  for (const e of ev) {
    const k = `${e.비목코드}-${e.세목코드}`;
    집행[k] = (집행[k] || 0) + e.집행금액;
    if (!예산[k]) error('R-22b', e.증빙ID, `예산에 없는 비목·세목 (${e.보조비목}(${e.비목코드})/${e.보조세목}(${e.세목코드}))`, '보조금법 §22 비목전용');
  }
  for (const [k, v] of Object.entries(집행)) {
    const b = 예산[k]; if (!b) continue;
    if (v > b.예산집행계획) {
      error('R-22', `${b.보조비목}/${b.보조세목}`, `집행액 ${won(v)} 이 예산 ${won(b.예산집행계획)} 초과 — 변경승인 없이는 불인정`, '보조금법 §22');
    }
  }

  // ── R-09 준공 필수문서 결손 ──────────────────────────
  const docSets = read('codes/completion-documents.json').유형별필수문서;
  for (const c of cp) {
    const 필수 = docSets[c.유형] || [];
    const 확보 = c.문서.filter((d) => ['제출완료', '확정'].includes(d.상태)).map((d) => d.문서명);
    const 결손 = 필수.filter((d) => !확보.includes(d));
    if (결손.length) {
      const lvl = c.상태 === '준공완료' || c.상태 === '인계완료' ? error : warn;
      lvl('R-09', c.준공ID, `준공 필수문서 ${결손.length}/${필수.length}건 결손: ${결손.join(', ')}`, '지방계약법 준용 / 협약');
    }
  }

  // ── R-10 설계변경 타당성검토 ─────────────────────────
  for (const c of ct) {
    for (const v of c.변경계약 || []) {
      const 증감률 = v.증감률 ?? ((v.변경후금액 - (v.변경전금액 || c.계약금액)) / (v.변경전금액 || c.계약금액)) * 100;
      if (증감률 >= B.설계변경_타당성검토_비율 && !v.타당성검토) {
        error('R-10', `${c.계약ID}/${v.차수}차`, `공사비 ${증감률.toFixed(1)}% 증액 — 조달청 타당성 검토 미이행`, '통합관리지침 §22①3호');
      }
      if (!v.변경승인번호) {
        warn('R-10b', `${c.계약ID}/${v.차수}차`, '사업계획 변경승인번호 미연결', '보조금법 §22');
      }
    }
  }

  // ── R-11 낙찰차액 처리 ───────────────────────────────
  const 총낙찰차액 = ct.reduce((s, c) => s + (c.낙찰차액 || 0), 0);
  if (총낙찰차액 > 0) {
    const 승인 = (base.변경승인이력 || []).some((a) => ['사업비변경', '비목전용'].includes(a.구분));
    (승인 ? warn : error)('R-11', '계약대장 전체', `낙찰차액 합계 ${won(총낙찰차액)} — 변경승인 없이는 전액 반납 대상`, '통합관리지침 §17① / §26①');
  }

  // ── R-12 집행률 vs 물리적 진도율 괴리 ────────────────
  const 계약별집행 = {};
  for (const e of ev) {
    if (e.계약ID) 계약별집행[e.계약ID] = (계약별집행[e.계약ID] || 0) + e.집행금액;
  }
  for (const c of cp) {
    if (!c.계약ID || c.물리적진도율 == null) continue;
    const 계약 = ctById[c.계약ID];
    if (!계약 || !계약.계약금액) continue;
    const 집행률 = ((계약별집행[c.계약ID] || 0) / 계약.계약금액) * 100;
    const 괴리 = Math.abs(집행률 - c.물리적진도율);
    if (괴리 > 15) {
      warn('R-12', c.준공ID, `집행률 ${집행률.toFixed(1)}% vs 물리적 진도율 ${c.물리적진도율}% (괴리 ${괴리.toFixed(1)}%p)`, '실적보고서 심사 지적사항');
    }
  }

  // ── R-13 ID 중복 ─────────────────────────────────────
  const dup = (arr, key, label) => {
    const seen = new Set();
    for (const x of arr) {
      if (seen.has(x[key])) error('R-13', x[key], `${label} ID 중복`, '무결성');
      seen.add(x[key]);
    }
  };
  dup(ev, '증빙ID', '증빙'); dup(ct, '계약ID', '계약');
  dup(as, '자산ID', '자산'); dup(cp, '준공ID', '준공');

  return { ev, ct, as, cp, 총합, 확정 };
}

// ─────────────────────────────────────────────────────────────
// 실행
// ─────────────────────────────────────────────────────────────
validateSchemas();
let stats = {};
if (!findings.some((f) => f.rule === 'SCHEMA')) {
  stats = validateRules();
} else {
  report('ERROR', 'SCHEMA', '-', '스키마 오류로 규칙 검증을 건너뜀', '-');
}

const errors = findings.filter((f) => f.level === 'ERROR');
const warns = findings.filter((f) => f.level === 'WARN');

if (JSON_OUT) {
  console.log(JSON.stringify({ 검사일시: new Date().toISOString(), 오류: errors.length, 경고: warns.length, 결과: findings }, null, 2));
} else {
  console.log('═'.repeat(78));
  console.log(' 아산시 강소형 스마트시티 정산시스템 — 원장 검증 결과');
  console.log('═'.repeat(78));
  if (stats.ev) {
    console.log(` 증빙 ${stats.ev.length}건 (확정 ${stats.확정.length}건) · 계약 ${stats.ct.length}건 · 자산 ${stats.as.length}건 · 준공 ${stats.cp.length}건`);
    console.log('─'.repeat(78));
  }
  for (const f of findings) {
    const tag = f.level === 'ERROR' ? '✗ 오류' : '△ 경고';
    console.log(`${tag} [${f.rule}] ${f.target}`);
    console.log(`        ${f.message}`);
    console.log(`        근거: ${f.law}`);
  }
  if (!findings.length) console.log(' 지적사항 없음');
  console.log('─'.repeat(78));
  console.log(` 오류 ${errors.length}건 · 경고 ${warns.length}건`);
  console.log('═'.repeat(78));
}

process.exit(errors.length > 0 || (STRICT && warns.length > 0) ? 1 : 0);
