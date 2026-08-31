#!/usr/bin/env node
/**
 * Notion DB 생성 · 속성 동기화
 *
 * 손으로 속성 30개를 만들면 오타가 난다. 오타 하나로 sync-notion.js 가 필드를 못 찾고,
 * 그 필드는 조용히 비어서 정산에 반영된다. 그래서 스키마에서 자동 생성한다.
 *
 * 환경변수:
 *   NOTION_TOKEN         내부 통합 토큰 (필수, --dry-run 제외)
 *   NOTION_PARENT_PAGE   DB를 생성할 상위 페이지 ID (신규 생성 시)
 *   NOTION_EVIDENCE_DB   기존 DB에 속성만 추가할 때 (contracts/assets/completion 동일)
 *
 * 사용법:
 *   node integrations/notion/setup-databases.js --dry-run          정의 미리보기 (토큰 불필요)
 *   node integrations/notion/setup-databases.js                    4종 전부 생성
 *   node integrations/notion/setup-databases.js --db evidence      정산증빙만
 *   node integrations/notion/setup-databases.js --db evidence --update   기존 DB에 누락 속성 추가
 *
 * 주의: Notion API는 "뷰(View)"를 만들 수 없다. 뷰는 DB 생성 후 화면에서
 *       직접 구성한다. 권장 뷰 구성은 integrations/notion/DB-SCHEMA.md 참조.
 */

const { DATABASES } = require('./db-definitions');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };

const DRY = has('--dry-run');
const UPDATE = has('--update');
const ONLY = val('--db', null);
const TOKEN = process.env.NOTION_TOKEN;
const PARENT = process.env.NOTION_PARENT_PAGE;

const targets = ONLY
  ? [DATABASES[ONLY]].filter(Boolean)
  : Object.values(DATABASES);

if (ONLY && !targets.length) {
  console.error(`--db 값이 올바르지 않습니다: ${ONLY}`);
  console.error(`사용 가능: ${Object.keys(DATABASES).join(', ')}`);
  process.exit(1);
}

// ── 미리보기 ─────────────────────────────────────────────
function preview(db) {
  const props = Object.entries(db.properties);
  console.log(`\n■ ${db.title}  (속성 ${props.length}개)`);
  console.log(`  ${db.description}`);
  console.log(`  Secret: ${db.secret}${db.sync ? `  ·  동기화: ${db.sync}` : '  ·  동기화: 미구현'}`);
  console.log('  ─────────────────────────────────────────────');
  for (const [name, spec] of props) {
    const type = Object.keys(spec)[0];
    const o = spec[type]?.options;
    const detail = o
      ? `${o.length}개 [${o.slice(0, 5).map((x) => x.name).join(', ')}${o.length > 5 ? ', …' : ''}]`
      : (spec[type]?.format || '');
    console.log(`    ${name.padEnd(18)} ${type.padEnd(16)} ${detail}`);
  }
}

if (DRY) {
  console.log('=== Notion DB 정의 미리보기 (--dry-run) ===');
  targets.forEach(preview);
  console.log('\n실제 생성: NOTION_TOKEN, NOTION_PARENT_PAGE 설정 후 --dry-run 없이 실행');
  process.exit(0);
}

// ── API ─────────────────────────────────────────────────
if (!TOKEN) { console.error('NOTION_TOKEN 이 필요합니다.'); process.exit(1); }

async function notion(method, endpoint, body) {
  const res = await fetch(`https://api.notion.com/v1/${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${endpoint} → ${res.status}\n${text.slice(0, 500)}`);
  return JSON.parse(text);
}

async function createDb(db) {
  if (!PARENT) throw new Error('NOTION_PARENT_PAGE 가 필요합니다 (DB를 생성할 상위 페이지 ID).');
  const created = await notion('POST', 'databases', {
    parent: { type: 'page_id', page_id: PARENT },
    title: [{ type: 'text', text: { content: db.title } }],
    description: [{ type: 'text', text: { content: db.description } }],
    properties: db.properties,
  });
  return created;
}

async function updateDb(db, id) {
  const existing = await notion('GET', `databases/${id}`);
  const have = Object.keys(existing.properties);
  const missing = Object.entries(db.properties).filter(([n]) => !have.includes(n));

  // 기존 select 속성에 누락된 선택지를 채운다 (스키마가 늘어난 경우)
  const optionPatch = {};
  for (const [name, spec] of Object.entries(db.properties)) {
    const type = Object.keys(spec)[0];
    if (!['select', 'multi_select'].includes(type)) continue;
    const cur = existing.properties[name];
    if (!cur || cur.type !== type) continue;
    const curNames = cur[type].options.map((o) => o.name);
    const want = spec[type].options;
    const add = want.filter((o) => !curNames.includes(o.name));
    if (add.length) {
      optionPatch[name] = { [type]: { options: [...cur[type].options, ...add] } };
    }
  }

  const patch = { ...Object.fromEntries(missing), ...optionPatch };
  if (!Object.keys(patch).length) {
    console.log(`  변경 없음 (속성 ${have.length}개 모두 존재)`);
    return existing;
  }
  if (missing.length) console.log(`  속성 추가 ${missing.length}개: ${missing.map(([n]) => n).join(', ')}`);
  for (const [n, p] of Object.entries(optionPatch)) {
    const t = Object.keys(p)[0];
    console.log(`  선택지 보강 ${n}: +${p[t].options.length - existing.properties[n][t].options.length}개`);
  }
  return notion('PATCH', `databases/${id}`, { properties: patch });
}

// ── 실행 ────────────────────────────────────────────────
(async () => {
  const results = [];
  for (const db of targets) {
    console.log(`\n■ ${db.title}`);
    const existingId = process.env[db.secret];
    let out;
    if (UPDATE || existingId) {
      if (!existingId) throw new Error(`--update 하려면 ${db.secret} 환경변수가 필요합니다.`);
      console.log(`  기존 DB 갱신 (${existingId})`);
      out = await updateDb(db, existingId);
    } else {
      out = await createDb(db);
      console.log(`  생성 완료`);
    }
    console.log(`  URL: ${out.url}`);
    console.log(`  ID : ${out.id}`);
    results.push({ db, id: out.id, url: out.url });
  }

  console.log('\n══════════════════════════════════════════════');
  console.log(' GitHub Secrets 에 등록할 값');
  console.log('══════════════════════════════════════════════');
  for (const r of results) {
    console.log(`  ${r.db.secret} = ${r.id.replace(/-/g, '')}`);
  }
  console.log('\n다음 단계');
  console.log('  1. 각 DB를 열어 우측 상단 ··· → 연결 → 내부 통합 추가');
  console.log('  2. 뷰 구성 (API로 불가) — integrations/notion/DB-SCHEMA.md 참조');
  console.log('  3. Apps Script 에서 testConnection() 실행하여 속성 확인');
  console.log('  4. npm run sync:dry 로 동기화 미리보기');
})().catch((e) => { console.error('\n실패:', e.message); process.exit(1); });
