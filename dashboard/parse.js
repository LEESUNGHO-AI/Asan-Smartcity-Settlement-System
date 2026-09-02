/**
 * 브라우저용 사업비 엑셀 파서
 *
 * scripts/import-xlsx.js(서버)와 codes/xlsx-mapping.json 을 함께 읽으므로
 * 화면에서 보이는 결과와 GitHub Actions 가 만드는 결과가 항상 같다.
 *
 * 필요: SheetJS(XLSX) 전역
 */
(function (global) {
  'use strict';

  var M = null, CODES = null, STAFF = {}, VENDOR = {};

  function load(base) {
    base = base || '../';
    var get = function (f) { return fetch(base + f).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }); };
    return Promise.all([
      get('codes/xlsx-mapping.json'), get('codes/expense-categories.json'),
      get('codes/staff.json'), get('codes/vendors.json')
    ]).then(function (a) {
      M = a[0]; CODES = a[1];
      // 엑셀에 없는 생년월일·참여율·사업자등록번호를 명부에서 붙인다
      if (a[2]) {
        (a[2].인력 || []).forEach(function (x) { STAFF[x.성명] = { 생년월일: x.생년월일, 참여율: x.기본참여율 }; });
        (((a[2].외부인력) || {}).명단 || []).forEach(function (x) { if (!STAFF[x.성명]) STAFF[x.성명] = { 생년월일: x.생년월일 }; });
      }
      if (a[3]) (a[3].거래처 || []).forEach(function (x) { if (x.사업자등록번호) VENDOR[x.상호] = x.사업자등록번호; });
      return true;
    });
  }

  function 지급처만들기(원본, 비목, 목적, mask, 개인강제) {
    var 이름 = 원본 || '(미기재)';
    var st = STAFF[이름];
    var 개인 = 개인강제 || !!st;
    var out = { 구분: 개인 ? '개인' : '사업자', 명칭: maskName(이름, 비목, 목적, mask) || '(미기재)' };
    if (개인) {
      if (st && st.생년월일) out.생년월일 = st.생년월일;
      if (st && typeof st.참여율 === 'number') out.참여율 = st.참여율;
    } else if (VENDOR[이름]) { out.사업자등록번호 = VENDOR[이름]; }
    return out;
  }

  var num = function (v) {
    if (v === null || v === undefined || v === '') return 0;
    var n = Number(String(v).replace(/[^0-9.-]/g, ''));
    return isNaN(n) ? 0 : Math.round(n);
  };
  function pad(n) { return String(n).length < 2 ? '0' + n : String(n); }
  function toDate(v) {
    if (!v) return null;
    if (v instanceof Date && !isNaN(v)) return v.getFullYear() + '-' + pad(v.getMonth() + 1) + '-' + pad(v.getDate());
    var t = String(v).trim();
    // 2024-03-25 / 2024.3.25
    var m = t.replace(/[.\/]/g, '-').match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return m[1] + '-' + pad(m[2]) + '-' + pad(m[3]);
    // 엑셀이 미국식으로 서식한 경우: 3/25/24
    m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (m) {
      var y = m[3].length === 2 ? '20' + m[3] : m[3];
      return y + '-' + pad(m[1]) + '-' + pad(m[2]);
    }
    // 엑셀 일련번호
    if (/^\d{5}$/.test(t)) {
      var d = new Date(Date.UTC(1899, 11, 30) + Number(t) * 86400000);
      return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
    }
    return null;
  }
  function splitCode(s) {
    if (!s) return null;
    var m = String(s).trim().match(/^(.+?)\s*\((\d{2,3})\)\s*$/);
    return m ? { 명칭: m[1].trim(), 코드: m[2] } : { 명칭: String(s).trim(), 코드: null };
  }
  function 코드찾기(비목, 세목) {
    var b = CODES.비목.filter(function (x) { return x.명칭 === 비목; })[0];
    if (!b) return null;
    var s = b.세목.filter(function (x) { return x.명칭 === 세목; })[0];
    return s ? { 비목코드: b.코드, 세목코드: s.코드 } : null;
  }
  function 단위사업추정(text) {
    for (var i = 0; i < M.단위사업규칙.length; i++) {
      if (new RegExp(M.단위사업규칙[i].패턴, 'i').test(text)) return M.단위사업규칙[i].코드;
    }
    return M.기본단위사업;
  }
  function maskName(name, 비목, 목적, mask) {
    if (!mask) return name;
    var n = String(name || '').trim();
    if (!n || new RegExp(M.법인어, 'i').test(n)) return n;
    var 개인 = 비목 === '인건비' || 비목 === '여비' || new RegExp(M.개인지급어).test(목적 || '');
    if (!개인 || !/^[가-힣]{2,4}$/.test(n)) return n;
    if (n.length === 2) return n[0] + '*';
    return n[0] + new Array(n.length - 1).join('*') + n[n.length - 1];
  }
  function rowsOf(wb, name) {
    var ws = wb.Sheets[name];
    return ws ? XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true, cellDates: true }) : null;
  }

  // ── 총괄 시트 → 예산 ──────────────────────────────────
  function parseBudget(wb, warn) {
    var rows = rowsOf(wb, '총괄');
    if (!rows) { warn('「총괄」 시트를 찾을 수 없습니다'); return []; }
    var h = -1;
    for (var i = 0; i < Math.min(rows.length, 15); i++) {
      var r = (rows[i] || []).map(function (x) { return String(x || '').trim(); });
      if (r[0] === '비목' && r[1] && r[1].indexOf('세목') >= 0) { h = i; break; }
    }
    if (h < 0) { warn('「총괄」 시트의 헤더 행을 찾지 못했습니다'); return []; }

    var out = {}, 현재비목 = null, 현재세목 = null;
    var 소계 = function (x) { return /^(소\s*계|합\s*계|총\s*계)$/.test(String(x || '').trim()); };
    for (var j = h + 2; j < rows.length; j++) {
      var row = rows[j] || [];
      if (소계(row[0]) || 소계(row[1]) || 소계(row[2])) continue;
      var b = splitCode(row[0]); if (b && b.명칭) 현재비목 = b;
      var s = splitCode(row[1]); if (s && s.명칭) 현재세목 = s;
      if (!현재비목 || !현재세목) continue;
      if (!row[2] && !s) continue;
      var 비목 = M.비목맵[현재비목.명칭] || 현재비목.명칭;
      var 세목 = M.세목맵[현재세목.명칭] || 현재세목.명칭;
      var c = 코드찾기(비목, 세목);
      if (!c) { warn('총괄: 코드 마스터에 없는 조합 — ' + 비목 + ' / ' + 세목); continue; }
      var k = c.비목코드 + '-' + c.세목코드;
      if (out[k]) out[k].예산집행계획 += num(row[3]);
      else out[k] = { 보조비목: 비목, 비목코드: c.비목코드, 보조세목: 세목, 세목코드: c.세목코드, 예산집행계획: num(row[3]) };
    }
    return Object.keys(out).map(function (k) { return out[k]; }).filter(function (x) { return x.예산집행계획 > 0; });
  }

  // ── 지출내역 시트 → 증빙 ──────────────────────────────
  function parseEvidence(wb, org, mask, warn) {
    var rows = rowsOf(wb, '지출내역');
    if (!rows) { warn('「지출내역」 시트를 찾을 수 없습니다'); return []; }
    var h = -1;
    for (var i = 0; i < Math.min(rows.length, 15); i++) {
      var r = (rows[i] || []).map(function (x) { return String(x || '').trim(); });
      if (r.indexOf('비목') >= 0 && r.indexOf('세목') >= 0 && r.indexOf('지출금액') >= 0) { h = i; break; }
    }
    if (h < 0) { warn('「지출내역」 시트의 헤더 행을 찾지 못했습니다'); return []; }
    var H = rows[h].map(function (x) { return String(x || '').trim(); });
    var col = function (n) { return H.indexOf(n); };
    var C = {
      비목: col('비목'), 세목: col('세목'), 산출기초: col('산출기초'), 결제방법: col('결제방법'),
      결제일자: H.map(function (x, k) { return x.indexOf('결제일자') === 0 ? k : -1; }).filter(function (k) { return k >= 0; })[0],
      이체일자: col('이체일자'), 지급처: col('지급처'), 내용: col('내용'),
      공급가액: col('공급가액'), 부가세: col('부가세'), 지출금액: col('지출금액'), 비고: col('비고'),
      재원: col('재원') >= 0 ? col('재원') : col('재원구분')
    };

    var out = [], seq = {};
    for (var n = h + 1; n < rows.length; n++) {
      var row = rows[n] || [];
      var 금액 = num(row[C.지출금액]);
      if (!금액 && !row[C.비목]) continue;
      var 비목원 = String(row[C.비목] || '').trim(), 세목원 = String(row[C.세목] || '').trim();
      if (!비목원 || !세목원) { warn((n + 1) + '행: 비목·세목 누락 (' + 금액.toLocaleString('ko-KR') + '원)'); continue; }
      var 비목 = M.비목맵[비목원] || 비목원, 세목 = M.세목맵[세목원] || 세목원;
      var c = 코드찾기(비목, 세목);
      if (!c) { warn((n + 1) + '행: 코드 마스터에 없는 조합 — ' + 비목원 + ' / ' + 세목원); continue; }
      var 결제원 = String(row[C.결제방법] || '').trim();
      var 결제 = M.결제맵[결제원] || { 지급방식: '기타', 증빙: [], 확정: false };
      if (!M.결제맵[결제원] && 결제원) warn((n + 1) + '행: 알 수 없는 결제방법 — ' + 결제원);
      var 일자 = toDate(row[C.이체일자]) || toDate(row[C.결제일자]);
      if (!일자) { warn((n + 1) + '행: 집행일자를 읽을 수 없음'); continue; }
      var 산출 = String(row[C.산출기초] || '').trim(), 내용 = String(row[C.내용] || '').trim();
      var 목적 = [산출, 내용].filter(Boolean).join(' — ') || 세목;
      var y = 일자.slice(0, 4); seq[y] = (seq[y] || 0) + 1;

      var rec = {
        증빙ID: 'EV-' + y + '-' + ('0000' + seq[y]).slice(-5),
        기관: org, 단위사업: 단위사업추정(산출 + ' ' + 내용 + ' ' + 세목),
        보조비목: 비목, 비목코드: c.비목코드, 보조세목: 세목, 세목코드: c.세목코드,
        재원: (C.재원 >= 0 && String(row[C.재원] || '').trim()) || '미구분', 계약ID: null,
        지급처: 지급처만들기(String(row[C.지급처] || '').trim(), 비목, 목적, mask, 비목 === '인건비'),
        집행일자: 일자, 집행금액: 금액, 사용목적: 목적,
        지급방식: 결제.지급방식, 증빙유형: 결제.증빙,
        검토상태: 비목 === '인건비' ? '보완필요' : (결제.확정 ? '제출완료' : '검토중'),
        감사추적: { 등록일시: new Date().toISOString(), 등록자: '대시보드 업로드', 출처: '시스템연계' }
      };
      var 공급 = num(row[C.공급가액]), 부가 = num(row[C.부가세]);
      if (공급) rec.공급가액 = 공급;
      if (부가) rec.부가세 = 부가;
      if (세목 === '일반수용비') rec.세부구분 = /회의/.test(산출 + 내용) ? '회의비' : '일반수용비';
      if (/선금|선급/.test(산출 + 내용)) rec.선금여부 = true;
      if (비목 === '인건비') { rec.귀속월 = 일자.slice(0, 7); rec.보완사유 = '인건비: 참여율·귀속월·필수증빙 보완 필요'; }
      var 비고 = String(row[C.비고] || '').trim();
      if (비고) rec.비고 = 비고;
      out.push(rec);
    }
    out.sort(function (a, b) { return a.집행일자 < b.집행일자 ? -1 : a.집행일자 > b.집행일자 ? 1 : 0; });
    return out;
  }

  // ── 화면용 간이 검증 ──────────────────────────────────
  // 정식 판정은 GitHub Actions 의 validate.js 가 한다. 여기서는 올리기 전에
  // 눈으로 확인할 수 있도록 대표 규칙만 돌린다.
  function check(evidence, budget) {
    var f = [], add = function (level, rule, cnt, msg, law) {
      if (cnt > 0) f.push({ 수준: level, 규칙: rule, 건수: cnt, 요약: msg, 근거: law });
    };
    var 인정 = ['계좌이체', '보조금전용카드'];
    add('ERROR', 'R-02', evidence.filter(function (e) { return 인정.indexOf(e.지급방식) < 0; }).length,
      '인정되지 않는 지급방식', '통합관리지침 §18①');
    add('ERROR', 'R-05', evidence.filter(function (e) { return !e.증빙유형 || !e.증빙유형.length; }).length,
      '증빙유형 미기재', '작성지침 §5');
    add('ERROR', 'R-08', evidence.filter(function (e) { return e.보조비목 === '인건비'; }).length,
      '인건비 참여율·증빙 보완 필요', '작성지침 §5');
    add('WARN', 'R-23', evidence.filter(function (e) { return e.집행금액 < 0; }).length,
      '환불·정정(음수 집행)', '작성지침 §5');
    add('ERROR', 'R-24', evidence.filter(function (e) { return e.재원 === '미구분'; }).length,
      '재원(국비·도비·시비) 구분 없음 — 엑셀에 재원 열 추가 필요', '작성지침 §4②');
    add('WARN', 'R-25', evidence.filter(function (e) {
      return e.지급처.구분 === '사업자' && !e.지급처.사업자등록번호; }).length,
      '사업자등록번호 미확보 — codes/vendors.json 보완', '작성지침 §5');
    var 예산맵 = {};
    budget.forEach(function (b) { 예산맵[b.비목코드 + '-' + b.세목코드] = b.예산집행계획; });
    var 집행 = {};
    evidence.forEach(function (e) { var k = e.비목코드 + '-' + e.세목코드; 집행[k] = (집행[k] || 0) + e.집행금액; });
    var 초과 = Object.keys(집행).filter(function (k) { return 예산맵[k] !== undefined && 집행[k] > 예산맵[k]; }).length;
    var 밖 = Object.keys(집행).filter(function (k) { return 예산맵[k] === undefined; }).length;
    add('ERROR', 'R-22', 초과, '예산 초과집행', '보조금법 §22');
    add('ERROR', 'R-22b', 밖, '예산에 없는 비목·세목', '보조금법 §22');
    return f;
  }

  // ── 총괄·지출 대사 ────────────────────────────────────
  function reconcile(budget, evidence, wb) {
    var rows = rowsOf(wb, '총괄'); if (!rows) return [];
    // 총괄의 '합계' 열(7번째)을 세목별로 모은다
    var tot = {}, 현재비목 = null, 현재세목 = null;
    var 소계 = function (x) { return /^(소\s*계|합\s*계|총\s*계)$/.test(String(x || '').trim()); };
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i] || [];
      if (소계(r[0]) || 소계(r[1]) || 소계(r[2])) continue;
      var b = splitCode(r[0]); if (b && b.명칭 && /^\d{3}$/.test(b.코드 || '')) 현재비목 = b;
      var s = splitCode(r[1]); if (s && s.명칭 && /^\d{2}$/.test(s.코드 || '')) 현재세목 = s;
      if (!현재비목 || !현재세목) continue;
      var v = Number(r[6]);
      if (!isNaN(v) && r[6] !== null && r[6] !== '') {
        var 비목 = M.비목맵[현재비목.명칭] || 현재비목.명칭, 세목 = M.세목맵[현재세목.명칭] || 현재세목.명칭;
        var c = 코드찾기(비목, 세목); if (!c) continue;
        var k = c.비목코드 + '-' + c.세목코드;
        tot[k] = (tot[k] || 0) + v;
      }
    }
    var 집행 = {};
    evidence.forEach(function (e) { var k = e.비목코드 + '-' + e.세목코드; 집행[k] = (집행[k] || 0) + e.집행금액; });
    var out = [];
    budget.forEach(function (b) {
      var k = b.비목코드 + '-' + b.세목코드;
      var a = tot[k] || 0, c2 = 집행[k] || 0;
      if (Math.abs(c2 - a) > 1000) out.push({ 세목: b.보조비목 + ' / ' + b.보조세목, 총괄: a, 지출내역: c2, 차이: c2 - a });
    });
    return out;
  }

  global.SMSParse = {
    load: load,
    parse: function (arrayBuffer, org, mask) {
      var warnings = [];
      var warn = function (m) { warnings.push(m); };
      var wb = XLSX.read(arrayBuffer, { type: 'array', cellDates: true });
      var budget = parseBudget(wb, warn);
      var evidence = parseEvidence(wb, org, mask, warn);
      return {
        시트: wb.SheetNames,
        budget: budget,
        evidence: evidence,
        findings: check(evidence, budget),
        대사: reconcile(budget, evidence, wb),
        warnings: warnings
      };
    }
  };
})(window);
