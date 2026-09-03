#!/usr/bin/env node
/**
 * Notion → GitHub 원장 통합 동기화
 *
 *   정산증빙 DB    → data/evidence.json
 *   계약대장 DB    → data/contracts.json
 *   중요재산 DB    → data/assets.json
 *   준공산출물 DB  → data/completion.json
 *
 * 방향은 단방향(Notion → GitHub)이다. 역방향은 신규 ID 되쓰기 하나뿐이며,
 * 채번 책임이 정본에 있기 때문이다.
 *
 * 사업비 엑셀에서 들어온 레코드(감사추적.출처 ≠ 'Notion')는 건드리지 않는다.
 * 두 경로가 같은 파일에 쓰므로 각자 자기 출처의 것만 교체한다.
 *
 * 환경변수
 *   NOTION_TOKEN            (필수)
 *   NOTION_EVIDENCE_DB      정산증빙   — 없으면 건너뜀
 *   NOTION_CONTRACTS_DB     계약대장
 *   NOTION_ASSETS_DB        중요재산
 *   NOTION_COMPLETION_DB    준공산출물
 *
 * 사용법
 *   node scripts/sync-notion.js                  전체
 *   node scripts/sync-notion.js --only evidence  하나만
 *   node scripts/sync-notion.js --dry-run        기록하지 않음
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const ONLY = (() => { const i = argv.indexOf('--only'); return i >= 0 ? argv[i + 1] : null; })();
const TOKEN = process.env.NOTION_TOKEN;
const API = 'https://api.notion.com/v1';
const VER = '2022-06-28';

if (!TOKEN) { console.error('NOTION_TOKEN 이 필요합니다.'); process.exit(1); }

const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const codes = read('codes/expense-categories.json');
const 문서세트 = read('codes/completion-documents.json').유형별필수문서;
const 경고 = [];
const warn = (m) => 경고.push(m);

// ── Notion 속성 추출 ──────────────────────────────────────
const P = {
  title: (v) => v?.title?.[0]?.plain_text?.trim() || null,
  text: (v) => v?.rich_text?.map((t) => t.plain_text).join('').trim() || null,
  select: (v) => v?.select?.name || null,
  multi: (v) => (v?.multi_select || []).map((o) => o.name),
  number: (v) => (typeof v?.number === 'number' ? v.number : null),
  date: (v) => v?.date?.start?.slice(0, 10) || null,
  url: (v) => v?.url || null,
  check: (v) => !!v?.checkbox,
};
const g = (q, name, fn) => fn(q[name]);

async function notion(method, endpoint, body) {
  const res = await fetch(`${API}${endpoint}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Notion-Version': VER, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 160)}`);
  return res.json();
}
async function fetchAll(db, sort) {
  const out = [];
  let cursor;
  do {
    const body = { page_size: 100, start_cursor: cursor };
    if (sort) body.sorts = [{ property: sort, direction: 'ascending' }];
    let data;
    try { data = await notion('POST', `/databases/${db}/query`, body); }
    catch (e) {
      if (!sort) throw e;
      data = await notion('POST', `/databases/${db}/query`, { page_size: 100, start_cursor: cursor });
    }
    out.push(...data.results);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return out;
}

// ── 공통 유틸 ────────────────────────────────────────────
const 감사추적 = (page, q) => ({
  등록일시: page.created_time,
  등록자: g(q, '등록자', P.text) || 'Notion',
  수정일시: page.last_edited_time,
  출처: 'Notion',
});
/** 생년월일 일(日) 자리 강제 마스킹 — 공개 저장소 대응 */
function maskDob(raw) {
  if (!raw) return { value: null, leaked: false };
  const v = String(raw).trim();
  if (/^'\d{2}\.\d{2}\.\*\*$/.test(v)) return { value: v, leaked: false };
  const m = v.match(/^'?(\d{2})\.(\d{2})\.(\d{2})$/);
  if (m) return { value: `'${m[1]}.${m[2]}.**`, leaked: true };
  return { value: null, leaked: true, invalid: v };
}
function 코드찾기(비목, 세목) {
  const b = codes.비목.find((x) => x.명칭 === 비목);
  if (!b) return null;
  const s = b.세목.find((x) => x.명칭 === 세목);
  return s ? { 비목코드: b.코드, 세목코드: s.코드 } : null;
}
const 옵션 = (rec, q, list) => {
  for (const [k, fn] of list) { const v = g(q, k, fn); if (v != null && v !== '') rec[k] = v; }
};

// ══════════════════════════════════════════════════════════
// 대상 정의 — DB 를 하나 더 붙이려면 여기에 한 덩어리만 추가한다
// ══════════════════════════════════════════════════════════
const 대상 = [
  {
    key: 'evidence', 이름: '정산증빙', env: 'NOTION_EVIDENCE_DB',
    file: 'data/evidence.json', schema: '../schema/evidence.schema.json',
    id: '증빙ID', prefix: 'EV', pad: 5, sort: '집행일자',
    map(page) {
      const q = page.properties;
      const 비목 = g(q, '보조비목', P.select), 세목 = g(q, '보조세목', P.select);
      const c = 코드찾기(비목, 세목);
      if (!c) { warn(`[정산증빙] 코드 마스터에 없는 조합 — ${비목} / ${세목}`); return null; }

      const 구분 = g(q, '지급처구분', P.select) || '사업자';
      const dob = maskDob(g(q, '생년월일', P.text));
      if (dob.leaked && !dob.invalid) warn('[정산증빙] 생년월일 원본이 Notion 에 있음 — 마스킹 처리함');
      if (dob.invalid) warn(`[정산증빙] 생년월일 형식 오류: '${dob.invalid}'`);

      const 지급처 = { 구분, 명칭: g(q, '지급처명', P.text) || '' };
      if (구분 === '사업자') { const b = g(q, '사업자등록번호', P.text); if (b) 지급처.사업자등록번호 = b; }
      else { if (dob.value) 지급처.생년월일 = dob.value; const r = g(q, '참여율', P.number); if (r != null) 지급처.참여율 = r; }

      const rec = {
        증빙ID: g(q, '증빙ID', P.title),
        기관: g(q, '기관', P.select), 단위사업: g(q, '단위사업', P.select),
        보조비목: 비목, 비목코드: c.비목코드, 보조세목: 세목, 세목코드: c.세목코드,
        재원: g(q, '재원', P.select) || '미구분',
        계약ID: g(q, '계약ID', P.text) || null,
        지급처,
        집행일자: g(q, '집행일자', P.date),
        집행금액: g(q, '집행금액', P.number) ?? 0,
        사용목적: g(q, '사용목적', P.text) || '',
        지급방식: g(q, '지급방식', P.select),
        증빙유형: g(q, '증빙유형', P.multi),
        검토상태: g(q, '검토상태', P.select) || '제출완료',
        감사추적: 감사추적(page, q),
      };
      옵션(rec, q, [['세부구분', P.select], ['공급가액', P.number], ['부가세', P.number],
        ['자산ID', P.text], ['귀속월', P.text], ['보완사유', P.text]]);
      if (g(q, '선금여부', P.check)) rec.선금여부 = true;
      if (q['승인인력여부']) rec.승인인력여부 = g(q, '승인인력여부', P.check);
      const link = g(q, '파일링크', P.url); if (link) rec.파일링크 = [link];
      const slack = g(q, 'Slack링크', P.url); if (slack) rec.비고 = `Slack: ${slack}`;

      const 결손 = ['기관', '단위사업', '재원', '집행일자', '지급방식'].filter((k) => !rec[k]);
      if (!지급처.명칭) 결손.push('지급처명');
      if (결손.length) { warn(`[정산증빙] 필수값 누락: ${결손.join(', ')}`); return null; }
      return rec;
    },
  },
  {
    key: 'contracts', 이름: '계약대장', env: 'NOTION_CONTRACTS_DB',
    file: 'data/contracts.json', schema: '../schema/contracts.schema.json',
    id: '계약ID', prefix: 'CT', pad: 4, sort: '계약일',
    map(page) {
      const q = page.properties;
      const rec = {
        계약ID: g(q, '계약ID', P.title),
        기관: g(q, '기관', P.select), 단위사업: g(q, '단위사업', P.select),
        계약명: g(q, '계약명', P.text) || '',
        계약유형: g(q, '계약유형', P.select), 계약방법: g(q, '계약방법', P.select),
        추정가격: g(q, '추정가격', P.number) ?? 0,
        계약금액: g(q, '계약금액', P.number) ?? 0,
        계약일: g(q, '계약일', P.date),
        계약상대자: { 상호: g(q, '계약상대자', P.text) || '' },
        감사추적: 감사추적(page, q),
      };
      const brn = g(q, '사업자등록번호', P.text); if (brn) rec.계약상대자.사업자등록번호 = brn;
      const 차액 = g(q, '낙찰차액', P.number);
      rec.낙찰차액 = 차액 != null ? 차액 : Math.max(0, rec.추정가격 - rec.계약금액);
      옵션(rec, q, [['착수일', P.date], ['준공예정일', P.date], ['준공일', P.date],
        ['시스템등록일', P.date], ['상태', P.select], ['비고', P.text]]);

      const 조달 = {};
      옵션(조달, q, [['나라장터공고번호', P.text], ['위탁구분', P.select]]);
      if (q['설계적정성검토']) 조달.설계적정성검토 = g(q, '설계적정성검토', P.check);
      if (Object.keys(조달).length) rec.조달 = 조달;
      const 하자 = g(q, '하자담보기간_개월', P.number);
      if (하자 != null) rec.보증 = { 하자담보기간_개월: 하자 };
      const link = g(q, '파일링크', P.url); if (link) rec.파일링크 = [link];

      const 결손 = ['계약ID', '기관', '단위사업', '계약유형', '계약방법', '계약일'].filter((k) => !rec[k]);
      if (!rec.계약명) 결손.push('계약명');
      if (결손.length) { warn(`[계약대장] 필수값 누락: ${결손.join(', ')}`); return null; }
      return rec;
    },
  },
  {
    key: 'assets', 이름: '중요재산', env: 'NOTION_ASSETS_DB',
    file: 'data/assets.json', schema: '../schema/assets.schema.json',
    id: '자산ID', prefix: 'AS', pad: 4, sort: '취득일',
    map(page) {
      const q = page.properties;
      const 구분 = g(q, '재산구분', P.select);
      // 처분제한기간은 재산구분으로 정해진다(지침 §46③). 값이 없으면 자동 산정한다.
      const 기간 = Number(g(q, '처분제한기간_년', P.select) || 0)
        || (['부동산', '선박', '부표·부잔교·부선거', '항공기'].includes(구분) ? 10 : 5);
      const 취득일 = g(q, '취득일', P.date);
      const 만료 = g(q, '처분제한만료일', P.date)
        || (취득일 ? `${Number(취득일.slice(0, 4)) + 기간}${취득일.slice(4)}` : null);

      const rec = {
        자산ID: g(q, '자산ID', P.title),
        기관: g(q, '기관', P.select), 단위사업: g(q, '단위사업', P.select),
        재산구분: 구분, 재산명: g(q, '재산명', P.text) || '',
        수량: g(q, '수량', P.number) ?? 1,
        취득가액: g(q, '취득가액', P.number) ?? 0,
        취득일,
        설치장소: g(q, '설치장소', P.text) || '',
        관리주체: g(q, '관리주체', P.text) || '',
        처분제한: { 기간_년: 기간, 만료일: 만료 },
        감사추적: 감사추적(page, q),
      };
      if (q['부기등기필요']) rec.처분제한.부기등기 = { 필요여부: g(q, '부기등기필요', P.check) };
      옵션(rec, q, [['규격', P.text], ['관리번호', P.text], ['운영주체', P.text],
        ['계약ID', P.text], ['상태', P.select], ['비고', P.text]]);
      const 보고일 = g(q, '취득보고일', P.date);
      if (보고일) {
        rec.보고 = { 취득보고일: 보고일 };
        const 처 = g(q, '보고처', P.text); if (처) rec.보고.보고처 = 처;
      }
      const ev = g(q, '증빙ID', P.text);
      if (ev) rec.증빙ID = ev.split(/[,\s]+/).filter(Boolean);
      const link = g(q, '파일링크', P.url); if (link) rec.파일링크 = [link];

      const 결손 = ['자산ID', '재산구분', '취득일'].filter((k) => !rec[k]);
      for (const k of ['재산명', '설치장소', '관리주체']) if (!rec[k]) 결손.push(k);
      if (결손.length) { warn(`[중요재산] 필수값 누락: ${결손.join(', ')}`); return null; }
      return rec;
    },
  },
  {
    key: 'completion', 이름: '준공산출물', env: 'NOTION_COMPLETION_DB',
    file: 'data/completion.json', schema: '../schema/completion.schema.json',
    id: '준공ID', prefix: 'CP', pad: 4, sort: null,
    map(page) {
      const q = page.properties;
      const 유형 = g(q, '유형', P.select);
      const 세트 = 문서세트[유형] || [];
      const 확보 = g(q, '확보문서', P.multi);
      const rec = {
        준공ID: g(q, '준공ID', P.title),
        단위사업: g(q, '단위사업', P.select),
        계약ID: g(q, '계약ID', P.text) || null,
        유형, 명칭: g(q, '명칭', P.text) || '',
        수행사: g(q, '수행사', P.text) || '',
        // 유형별 필수문서 세트가 기준이고, 「확보문서」에 체크된 것만 제출완료로 본다
        문서: 세트.map((d) => ({ 문서명: d, 필수여부: true, 상태: 확보.includes(d) ? '제출완료' : '미제출' })),
        상태: g(q, '상태', P.select) || '진행중',
        감사추적: 감사추적(page, q),
      };
      const 진도 = g(q, '물리적진도율', P.number); if (진도 != null) rec.물리적진도율 = 진도;
      const 검사 = {};
      옵션(검사, q, [['예비준공검사일', P.date], ['준공검사일', P.date], ['검사자', P.text],
        ['검수일', P.date], ['검수자', P.text], ['지적사항', P.text], ['조치완료일', P.date]]);
      if (Object.keys(검사).length) rec.검사 = 검사;
      const 인계 = {};
      옵션(인계, q, [['인계일', P.date], ['인수기관', P.text]]);
      if (Object.keys(인계).length) rec.인계 = 인계;
      const 비고 = g(q, '비고', P.text); if (비고) rec.비고 = 비고;

      const 결손 = ['준공ID', '단위사업'].filter((k) => !rec[k]);
      if (!유형) 결손.push('유형');
      if (!rec.명칭) 결손.push('명칭');
      if (결손.length) { warn(`[준공산출물] 필수값 누락: ${결손.join(', ')}`); return null; }
      return rec;
    },
  },
];

// ══════════════════════════════════════════════════════════
async function 동기화(t) {
  const db = process.env[t.env];
  if (!db) { console.log(`  ${t.이름.padEnd(6)} ${t.env} 미설정 — 건너뜀`); return null; }

  const pages = await fetchAll(db, t.sort);
  const parsed = [];
  for (const pg of pages) {
    const rec = t.map(pg);
    if (rec) parsed.push({ rec, pageId: pg.id });
  }

  const prev = read(t.file);
  const prevById = Object.fromEntries(prev.레코드.map((r) => [r[t.id], r]));
  // 엑셀 등 다른 경로에서 들어온 레코드는 보존한다
  const 타출처 = prev.레코드.filter((r) => (r.감사추적 || {}).출처 !== 'Notion');

  const year = new Date().getFullYear();
  let seq = prev.레코드.reduce((m, r) => Math.max(m, Number((r[t.id] || '').split('-')[2] || 0)), 0);
  const 신규 = [];
  for (const item of parsed) {
    if (!item.rec[t.id]) {
      item.rec[t.id] = `${t.prefix}-${year}-${String(++seq).padStart(t.pad, '0')}`;
      신규.push(item);
    }
    const old = prevById[item.rec[t.id]];
    if (old?.감사추적?.등록일시) item.rec.감사추적.등록일시 = old.감사추적.등록일시;
  }

  const records = 타출처.concat(parsed.map((i) => i.rec))
    .sort((a, b) => String(a[t.id]).localeCompare(String(b[t.id])));

  const seen = new Set();
  for (const r of records) {
    if (seen.has(r[t.id])) warn(`[${t.이름}] ${r[t.id]} 중복`);
    seen.add(r[t.id]);
  }

  console.log(`  ${t.이름.padEnd(6)} Notion ${String(pages.length).padStart(4)}건 → 유효 ${String(parsed.length).padStart(4)}건 · ` +
    `타출처 보존 ${String(타출처.length).padStart(4)}건 · 신규채번 ${신규.length}건 → 합계 ${records.length}건`);

  if (!DRY) {
    fs.writeFileSync(path.join(ROOT, t.file),
      JSON.stringify({ $schema: t.schema, 갱신일시: new Date().toISOString(), 레코드: records }, null, 2) + '\n', 'utf8');
    for (const item of 신규) {
      await notion('PATCH', `/pages/${item.pageId}`, {
        properties: { [t.id]: { title: [{ text: { content: item.rec[t.id] } }] } },
      });
    }
  }
  return { 합계: records.length };
}

(async () => {
  console.log('Notion → 원장 통합 동기화');
  const 목록 = ONLY ? 대상.filter((t) => t.key === ONLY) : 대상;
  if (ONLY && !목록.length) {
    console.error(`--only 값 오류: ${ONLY} (evidence / contracts / assets / completion)`);
    process.exit(1);
  }

  const 결과 = [];
  for (const t of 목록) {
    try { const r = await 동기화(t); if (r) 결과.push(r); }
    catch (e) { console.error(`  ${t.이름.padEnd(6)} 실패 — ${e.message}`); warn(`[${t.이름}] ${e.message}`); }
  }

  console.log('─'.repeat(72));
  console.log(` ${결과.length}개 DB 동기화 · 총 ${결과.reduce((s, r) => s + r.합계, 0)}건`);
  if (경고.length) {
    console.log(` 경고 ${경고.length}건`);
    [...new Set(경고)].slice(0, 20).forEach((w) => console.log('   -', w));
    if (!DRY) fs.writeFileSync(path.join(ROOT, 'sync-warnings.txt'), 경고.join('\n'), 'utf8');
  }
  if (DRY) console.log(' --dry-run: 파일을 기록하지 않았습니다.');
})().catch((e) => { console.error(e.message); process.exit(1); });
