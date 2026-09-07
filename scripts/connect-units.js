#!/usr/bin/env node
/**
 * 단위시스템 자동 연동 커넥터
 *
 * 이미 운영 중인 단위시스템의 GitHub 데이터를 읽어와 정산 원장을 채운다.
 * 사람이 데이터를 다시 입력하지 않는다. 각 시스템에서 갱신하면 여기로 자동 반영된다.
 *
 *   BMS 예산관리   → 재원 구분(국비/도비/시비) · 비목별 집계
 *                    → evidence 의 '미구분' 재원을 BMS 비율로 안분 (R-24 해소)
 *   WBS 진척       → 준공 단위공사별 물리적 진도율
 *   자산관리       → (이미 Notion 중요재산 DB 로 연동됨, 참조만)
 *
 * 사용법:
 *   node scripts/connect-units.js            전체 연동
 *   node scripts/connect-units.js --dry-run  변경사항만 출력
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DRY = process.argv.includes('--dry-run');
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

// 단위시스템 데이터 소스 (GitHub raw)
const 소스 = {
  BMS: 'https://raw.githubusercontent.com/LEESUNGHO-AI/Asan-Smart-City-Budget-Management-System-BMS-/main/data.json',
  WBS: 'https://raw.githubusercontent.com/LEESUNGHO-AI/Asan-Smartcity-WBS/main/data/summary-data.json',
  HR:  'https://raw.githubusercontent.com/LEESUNGHO-AI/Asan-HR-Management-Portal/main/data/hr.json',
  ASSET: 'https://raw.githubusercontent.com/LEESUNGHO-AI/Asan-asset-management/main/data/assets.json',
};

// HR 기관명 → 정산 기관코드
const HR기관 = {
  '제일엔지니어링종합건축사사무소': 'JEIL',
  '충남연구원': 'CNI',
  '한국과학기술원': 'KAIST', '한국과학기술원 (KAIST)': 'KAIST',
  '호서대학교 산학협력단': 'HOSEO',
};

// WBS 대분류 → 정산 단위사업 매핑
const WBS단위사업 = {
  '서비스 구축': ['SP-AI', 'SP-INNO'],
  '나라장터 발주 지원': ['SP-NET', 'SP-POLE', 'SP-STORE'],
  '사업총괄': ['SP-PMO'],
  '프로젝트 관리/거버넌스': ['SP-PMO'],
  '통합시험/시범운영': ['SP-DRT'],
  '준공/검수/이관': ['SP-OASIS'],
};

async function fetchJson(url, name) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${name} 조회 실패 ${res.status}`);
  return res.json();
}

(async () => {
  console.log('단위시스템 연동');
  const 변경 = [];

  // ── 1) BMS → 재원 구분 (R-24 해소) ────────────────────
  let bms;
  try {
    bms = await fetchJson(소스.BMS, 'BMS');
    console.log(`  BMS 예산관리 (${bms.updated_at || '?'})`);
    const 재원 = {};
    for (const s of bms.source_summary || []) 재원[s.재원] = s.비율 / 100;
    console.log(`    재원비율: ${Object.entries(재원).map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`).join(' / ')}`);

    // evidence 의 '미구분' 을 BMS 재원 비율로 안분한다.
    // 개별 지출의 실제 재원은 알 수 없으므로, 집행 순서대로 비율에 맞춰 배분한다.
    const ev = read('data/evidence.json');
    const 미구분 = ev.레코드.filter((e) => e.재원 === '미구분');
    if (미구분.length && Object.keys(재원).length) {
      const 총 = 미구분.reduce((s, e) => s + e.집행금액, 0);
      const 목표 = {};
      for (const [k, v] of Object.entries(재원)) 목표[k] = 총 * v;
      const 누적 = { 국비: 0, 도비: 0, 시비: 0 };
      // 금액 큰 순으로 정렬해 배분 정확도를 높인다
      const 정렬 = [...미구분].sort((a, b) => b.집행금액 - a.집행금액);
      for (const e of 정렬) {
        // 목표 대비 가장 덜 채워진 재원에 배정
        let best = null, bestGap = -Infinity;
        for (const k of Object.keys(목표)) {
          const gap = (목표[k] - 누적[k]) / (목표[k] || 1);
          if (gap > bestGap) { bestGap = gap; best = k; }
        }
        e.재원 = best;
        e.재원배분 = 'BMS 비율 안분';
        누적[best] += e.집행금액;
      }
      const 결과 = {};
      for (const e of 미구분) 결과[e.재원] = (결과[e.재원] || 0) + e.집행금액;
      console.log(`    재원 안분: ${미구분.length}건 → ${Object.entries(결과).map(([k, v]) => `${k} ${(v / 1e8).toFixed(1)}억`).join(' / ')}`);
      변경.push(['evidence', ev, 'data/evidence.json']);
    } else {
      console.log(`    미구분 ${미구분.length}건 (안분 대상 없음)`);
    }
  } catch (e) {
    console.log(`  BMS: ${e.message} — 건너뜀`);
  }

  // ── 2) WBS → 준공 진도율 ──────────────────────────────
  try {
    const wbs = await fetchJson(소스.WBS, 'WBS');
    console.log(`  WBS 진척 (${wbs.meta?.generatedAtKst || '?'})`);
    const 단위진도 = {};
    for (const c of wbs.byCategory || []) {
      const sps = WBS단위사업[c.name] || [];
      for (const sp of sps) {
        // 여러 대분류가 한 단위사업에 매핑되면 최대 진도율 사용
        단위진도[sp] = Math.max(단위진도[sp] || 0, c.actualRate);
      }
    }
    console.log(`    ${Object.entries(단위진도).map(([k, v]) => `${k} ${v.toFixed(0)}%`).join(' / ')}`);

    const comp = read('data/completion.json');
    let n = 0;
    for (const r of comp.레코드) {
      if (단위진도[r.단위사업] != null) {
        const 새값 = Math.round(단위진도[r.단위사업]);
        if (r.물리적진도율 !== 새값) { r.물리적진도율 = 새값; r.진도출처 = 'WBS'; n++; }
      }
    }
    if (n) { console.log(`    준공 진도율 ${n}건 갱신`); 변경.push(['completion', comp, 'data/completion.json']); }
    else console.log('    진도율 변경 없음');
  } catch (e) {
    console.log(`  WBS: ${e.message} — 건너뜀`);
  }

  // ── 3) HR → 인건비 참여율·참여인력 명부 ────────────────
  try {
    const hr = await fetchJson(소스.HR, 'HR');
    console.log(`  HR 참여인력 (${hr.meta?.updated_at || '?'})`);
    // 참여인력 명부를 staff.json 형식으로 갱신 (기관·참여율)
    const 인력 = [];
    for (const org of hr.orgs || []) {
      const 코드 = HR기관[org.org] || org.org;
      for (const m of org.members || []) {
        인력.push({ 성명: m.name, 소속: 코드, 직위: m.position || '', 역할: m.role || '',
          기본참여율: m.ratio ?? m.participationRate ?? null,
          참여기간: `${m.from || ''} ~ ${m.to || ''}`, 상태: m.status || '' });
      }
    }
    console.log(`    참여인력 ${인력.length}명 (${[...new Set(인력.map(x => x.소속))].join('·')})`);

    // codes/staff.json 갱신 — 생년월일은 기존 값 보존(HR 에 없음), 참여율은 HR 로 갱신
    let staff = { 설명: 'HR 시스템 연동 참여인력 명부. 생년월일은 별도 보안자료.', 인력: [] };
    try {
      const 기존 = read('codes/staff.json');
      const 생년 = {};
      (기존.인력 || []).forEach((x) => { if (x.생년월일) 생년[x.성명] = x.생년월일; });
      staff.인력 = 인력.map((x) => 생년[x.성명] ? { ...x, 생년월일: 생년[x.성명] } : x);
      staff.외부인력 = 기존.외부인력;
    } catch (e) { staff.인력 = 인력; }
    if (!DRY) fs.writeFileSync(path.join(ROOT, 'codes/staff.json'), JSON.stringify(staff, null, 2) + '\n');
    변경.push(['staff', null, null]);

    // evidence 의 인건비 건에 참여율 채우기
    const 율맵 = {};
    for (const x of 인력) if (x.기본참여율 != null) 율맵[x.성명] = x.기본참여율;
    const ev2 = read('data/evidence.json');
    let 채움 = 0;
    for (const e of ev2.레코드) {
      if (e.보조비목 === '인건비' && e.지급처?.구분 === '개인') {
        const nm = (e.지급처.명칭 || '').replace(/\*/g, '');
        // 마스킹된 이름은 매칭 불가 → 원본 staff 로 역참조는 생략, 참여율만 명부 기준
        if (e.지급처.참여율 == null && 율맵[e.지급처.명칭]) {
          e.지급처.참여율 = 율맵[e.지급처.명칭]; 채움++;
        }
      }
    }
    if (채움 && !DRY) { fs.writeFileSync(path.join(ROOT, 'data/evidence.json'), JSON.stringify(ev2, null, 2) + '\n'); console.log(`    인건비 참여율 ${채움}건 반영`); }
  } catch (e) {
    console.log(`  HR: ${e.message} — 건너뜀`);
  }

  // ── 기록 ──────────────────────────────────────────────
  console.log('─'.repeat(56));
  if (DRY) { console.log(` --dry-run: ${변경.length}개 파일 변경 예정 (기록 안 함)`); return; }
  for (const [name, obj, file] of 변경) {
    if (!obj || !file) continue;  // staff 등 이미 기록된 항목
    obj.갱신일시 = new Date().toISOString();
    fs.writeFileSync(path.join(ROOT, file), JSON.stringify(obj, null, 2) + '\n');
  }
  console.log(` ${변경.length}개 원장 갱신 완료`);
})().catch((e) => { console.error(e.message); process.exit(1); });
