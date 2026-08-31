#!/usr/bin/env node
/**
 * Notion 정산증빙 DB → data/evidence.json 동기화
 *
 * 방향은 단방향(Notion → GitHub)이다. 유일한 역방향은 신규 증빙ID 되쓰기로,
 * 채번 책임이 정본에 있기 때문이다.
 *
 * 환경변수:
 *   NOTION_TOKEN         내부 통합 토큰
 *   NOTION_EVIDENCE_DB   정산증빙 DB ID
 *
 * 사용법:
 *   node scripts/sync-notion.js            실제 동기화
 *   node scripts/sync-notion.js --dry-run  변경사항만 출력, 파일 미기록
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DRY = process.argv.includes('--dry-run');
const TOKEN = process.env.NOTION_TOKEN;
const DB = process.env.NOTION_EVIDENCE_DB;
const API = 'https://api.notion.com/v1';
const VER = '2022-06-28';

if (!TOKEN || !DB) {
  console.error('환경변수 NOTION_TOKEN, NOTION_EVIDENCE_DB 가 필요합니다.');
  process.exit(1);
}

const readJson = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const codes = readJson('codes/expense-categories.json');

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

/** 코드 마스터에서 비목코드·세목코드를 유도한다. 사람이 입력하면 틀리므로 자동으로 붙인다. */
function deriveCodes(비목, 세목) {
  const b = codes.비목.find((x) => x.명칭 === 비목);
  if (!b) return { err: `보조비목 '${비목}' 이 코드 마스터에 없음` };
  const s = b.세목.find((x) => x.명칭 === 세목);
  if (!s) return { err: `보조세목 '${세목}' 이 ${비목}(${b.코드}) 하위에 없음` };
  return { 비목코드: b.코드, 세목코드: s.코드 };
}

/** 생년월일 일(日) 자리 강제 마스킹. Notion에 원본이 있으면 경고를 남긴다. */
function maskDob(raw) {
  if (!raw) return { value: null, leaked: false };
  const v = raw.trim();
  if (/^'\d{2}\.\d{2}\.\*\*$/.test(v)) return { value: v, leaked: false };
  const m = v.match(/^'?(\d{2})\.(\d{2})\.(\d{2})$/);
  if (m) return { value: `'${m[1]}.${m[2]}.**`, leaked: true };
  return { value: null, leaked: true, invalid: v };
}

// ── Notion 조회 ──────────────────────────────────────────
async function notion(method, endpoint, body) {
  const res = await fetch(`${API}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Notion-Version': VER,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Notion ${method} ${endpoint} → ${res.status} ${await res.text()}`);
  return res.json();
}

async function fetchAll() {
  const pages = [];
  let cursor;
  do {
    const data = await notion('POST', `/databases/${DB}/query`, {
      page_size: 100,
      start_cursor: cursor,
      sorts: [{ property: '집행일자', direction: 'ascending' }],
    });
    pages.push(...data.results);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return pages;
}

// ── 변환 ────────────────────────────────────────────────
function toRecord(page, warn) {
  const q = page.properties;
  const 비목 = P.select(q['보조비목']);
  const 세목 = P.select(q['보조세목']);
  const c = deriveCodes(비목, 세목);
  if (c.err) { warn(page, c.err); return null; }

  const 구분 = P.select(q['지급처구분']) || '사업자';
  const dob = maskDob(P.text(q['생년월일']));
  if (dob.leaked && !dob.invalid) {
    warn(page, `생년월일 원본이 Notion에 저장되어 있음 — 마스킹 처리했으나 Notion 측 정리 필요`);
  }
  if (dob.invalid) warn(page, `생년월일 형식 오류: '${dob.invalid}'`);

  const 지급처 = { 구분, 명칭: P.text(q['지급처명']) || '' };
  if (구분 === '사업자') {
    const brn = P.text(q['사업자등록번호']);
    if (brn) 지급처.사업자등록번호 = brn;
  } else {
    if (dob.value) 지급처.생년월일 = dob.value;
    const rate = P.number(q['참여율']);
    if (rate != null) 지급처.참여율 = rate;
  }

  const rec = {
    증빙ID: P.title(q['증빙ID']),
    기관: P.select(q['기관']),
    단위사업: P.select(q['단위사업']),
    보조비목: 비목,
    비목코드: c.비목코드,
    보조세목: 세목,
    세목코드: c.세목코드,
    재원: P.select(q['재원']),
    계약ID: P.text(q['계약ID']) || null,
    지급처,
    집행일자: P.date(q['집행일자']),
    집행금액: P.number(q['집행금액']) ?? 0,
    사용목적: P.text(q['사용목적']) || '',
    지급방식: P.select(q['지급방식']),
    증빙유형: P.multi(q['증빙유형']),
    검토상태: P.select(q['검토상태']) || '제출완료',
    감사추적: {
      등록일시: page.created_time,
      등록자: P.text(q['등록자']) || 'Notion',
      수정일시: page.last_edited_time,
      출처: 'Notion',
    },
  };

  const opt = {
    세부구분: P.select(q['세부구분']),
    공급가액: P.number(q['공급가액']),
    부가세: P.number(q['부가세']),
    자산ID: P.text(q['자산ID']),
    귀속월: P.text(q['귀속월']),
    보완사유: P.text(q['보완사유']),
  };
  for (const [k, v] of Object.entries(opt)) if (v != null && v !== '') rec[k] = v;
  if (P.check(q['선금여부'])) rec.선금여부 = true;
  if (q['승인인력여부']) rec.승인인력여부 = P.check(q['승인인력여부']);

  const link = P.url(q['파일링크']);
  if (link) rec.파일링크 = [link];
  const slack = P.url(q['Slack링크']);
  if (slack) rec.비고 = `Slack: ${slack}`;

  const 필수 = ['기관', '단위사업', '재원', '집행일자', '지급방식'];
  const 결손 = 필수.filter((k) => !rec[k]);
  if (결손.length) { warn(page, `필수값 누락: ${결손.join(', ')}`); return null; }
  if (!지급처.명칭) { warn(page, '지급처명 누락'); return null; }

  return { rec, pageId: page.id };
}

// ── 실행 ────────────────────────────────────────────────
(async () => {
  const warnings = [];
  const warn = (page, msg) => {
    const t = P.title(page.properties['증빙ID']) || page.id.slice(0, 8);
    warnings.push(`[${t}] ${msg}`);
  };

  console.log('Notion 조회 중...');
  const pages = await fetchAll();
  console.log(`  ${pages.length}건 수신`);

  const parsed = pages.map((p) => toRecord(p, warn)).filter(Boolean);

  // 기존 원장의 등록일시를 보존한다(감사추적의 최초 등록 시점이 바뀌면 안 된다)
  const prevFile = 'data/evidence.json';
  const prev = readJson(prevFile);
  const prevById = Object.fromEntries(prev.레코드.map((r) => [r.증빙ID, r]));

  // 채번: 기존 최대 일련번호 이후로 부여
  const year = new Date().getFullYear();
  let seq = prev.레코드.reduce((m, r) => {
    const n = Number((r.증빙ID || '').split('-')[2] || 0);
    return Math.max(m, n);
  }, 0);

  const 신규채번 = [];
  for (const item of parsed) {
    if (!item.rec.증빙ID) {
      item.rec.증빙ID = `EV-${year}-${String(++seq).padStart(5, '0')}`;
      신규채번.push(item);
    }
    const old = prevById[item.rec.증빙ID];
    if (old?.감사추적?.등록일시) item.rec.감사추적.등록일시 = old.감사추적.등록일시;
  }

  const records = parsed.map((i) => i.rec)
    .sort((a, b) => a.집행일자.localeCompare(b.집행일자) || a.증빙ID.localeCompare(b.증빙ID));

  // 중복 ID 방어
  const seen = new Set();
  for (const r of records) {
    if (seen.has(r.증빙ID)) warnings.push(`[${r.증빙ID}] 증빙ID 중복 — Notion에서 정리 필요`);
    seen.add(r.증빙ID);
  }

  const added = records.filter((r) => !prevById[r.증빙ID]).length;
  const removed = prev.레코드.filter((r) => !seen.has(r.증빙ID)).length;

  console.log('\n── 동기화 요약 ──────────────────────────────');
  console.log(`  기존 ${prev.레코드.length}건 → 신규 ${records.length}건`);
  console.log(`  추가 ${added}건 / 신규채번 ${신규채번.length}건 / Notion에서 사라진 건 ${removed}건`);
  if (removed > 0) {
    console.log('  ⚠ Notion에서 삭제된 증빙이 있습니다. 원장은 삭제 대신 검토상태 전환이 원칙입니다.');
  }
  if (warnings.length) {
    console.log(`\n  경고 ${warnings.length}건`);
    warnings.slice(0, 30).forEach((w) => console.log('   -', w));
    if (warnings.length > 30) console.log(`   ... 외 ${warnings.length - 30}건`);
  }

  if (DRY) { console.log('\n--dry-run: 파일을 기록하지 않았습니다.'); return; }

  fs.writeFileSync(
    path.join(ROOT, prevFile),
    JSON.stringify({ $schema: '../schema/evidence.schema.json', 갱신일시: new Date().toISOString(), 레코드: records }, null, 2) + '\n',
    'utf8'
  );
  console.log(`\n${prevFile} 기록 완료`);

  // 신규 채번분을 Notion에 되쓴다
  for (const item of 신규채번) {
    await notion('PATCH', `/pages/${item.pageId}`, {
      properties: { 증빙ID: { title: [{ text: { content: item.rec.증빙ID } }] } },
    });
  }
  if (신규채번.length) console.log(`증빙ID ${신규채번.length}건 Notion 되쓰기 완료`);

  fs.writeFileSync(path.join(ROOT, 'sync-warnings.txt'), warnings.join('\n'), 'utf8');
})().catch((e) => { console.error(e.message); process.exit(1); });
