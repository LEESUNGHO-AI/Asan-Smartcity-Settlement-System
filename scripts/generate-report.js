#!/usr/bin/env node
/**
 * 보조사업 집행결과 제출 양식 자동 생성기
 *
 * data/*.json (정본) → 「별첨4 보조사업 집행결과 제출 양식」 DOCX
 *
 *   1. 사업개요                    ← baseline.json
 *   2. 집행내역(연도별)             ← baseline.연도별교부내역 + evidence.json
 *   3. 보조비목별 총괄명세서         ← budget.json(A) + evidence.json(B)
 *   4. 보조비목별 일자별 집행내역     ← evidence.json (기간 필터)
 *   4-1. 보조비목별 세부집행내역      ← evidence.json (비목별 유형에 따라 표 구성)
 *
 * 사용법:
 *   node scripts/generate-report.js --from 2025-10-01 --to 2026-06-30 --org JEIL
 *
 * R-01(기준정보 미확정)이 해결되지 않으면 경고와 함께 워터마크가 표시된다.
 */

const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  WidthType, ShadingType, AlignmentType, BorderStyle, VerticalAlign,
  Footer, PageNumber, convertMillimetersToTwip,
} = require('docx');

const ROOT = path.resolve(__dirname, '..');
const FONT = '맑은 고딕';
const W = 9639; // A4 - 좌우 20mm

// ── 인자 ────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const FROM = arg('--from', '2000-01-01');
const TO = arg('--to', '2099-12-31');
const ORG = arg('--org', 'JEIL');

const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const base = read('data/baseline.json');
const budget = read('data/budget.json').레코드;
const codes = read('codes/expense-categories.json');
const orgs = read('codes/organizations.json').코드;

const all = read('data/evidence.json').레코드
  .filter((e) => e.기관 === ORG && e.검토상태 === '확정');
const inPeriod = all.filter((e) => e.집행일자 >= FROM && e.집행일자 <= TO);

// ── 포맷 ────────────────────────────────────────────────
const num = (n) => (n ?? 0).toLocaleString('ko-KR');
const pct = (b, a) => (a > 0 ? ((b / a) * 100).toFixed(1) + '%' : '-');
const kdate = (s) => s.replace(/-/g, '.').replace(/\.(\d{2})\.(\d{2})$/, '.$1.$2');
const 비목표기 = (e) => `${e.보조비목}(${e.비목코드})`;
const 세목표기 = (e) => `${e.보조세목}(${e.세목코드})`;
const 비목순서 = codes.비목.map((b) => b.코드);
const 유형 = (code) => (codes.비목.find((b) => b.코드 === code) || {}).세부집행내역_유형 || '지급처';

// ── 문단·표 헬퍼 ─────────────────────────────────────────
const r = (t, o = {}) => new TextRun({
  text: String(t), font: FONT, size: o.size || 18,
  bold: !!o.bold, color: o.color || '000000',
});
const p = (t, o = {}) => new Paragraph({
  alignment: o.align || AlignmentType.LEFT,
  spacing: { before: o.before ?? 20, after: o.after ?? 20 },
  children: [r(t, o)],
});
const heading = (t) => new Paragraph({
  spacing: { before: 300, after: 120 },
  children: [r(t, { size: 22, bold: true })],
});
const sub = (t) => new Paragraph({
  spacing: { before: 200, after: 80 },
  indent: { left: 200 },
  children: [r(t, { size: 20, bold: true })],
});

function cell(text, o = {}) {
  return new TableCell({
    width: { size: o.w, type: WidthType.DXA },
    columnSpan: o.span,
    verticalAlign: VerticalAlign.CENTER,
    margins: { top: 30, bottom: 30, left: 60, right: 60 },
    shading: o.fill ? { type: ShadingType.CLEAR, fill: o.fill, color: 'auto' } : undefined,
    children: [new Paragraph({
      alignment: o.align === 'c' ? AlignmentType.CENTER
        : o.align === 'r' ? AlignmentType.RIGHT : AlignmentType.LEFT,
      spacing: { before: 10, after: 10 },
      children: [r(text, { size: o.size || 16, bold: o.bold })],
    })],
  });
}

/** headers: [{t, align}] / rows: [[{t, align, bold, fill}]] / weights: number[] */
function table(headers, rows, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  const cols = weights.map((x) => Math.round(W * x / sum));
  cols[cols.length - 1] = W - cols.slice(0, -1).reduce((a, b) => a + b, 0);
  const hr = new TableRow({
    tableHeader: true,
    children: headers.map((h, i) =>
      cell(typeof h === 'string' ? h : h.t, { w: cols[i], align: 'c', bold: true, fill: 'D9E2F3' })),
  });
  const br = rows.map((row) => new TableRow({
    children: row.map((c, i) => {
      const o = typeof c === 'object' && c !== null ? c : { t: c };
      return cell(o.t, { w: cols[i], align: o.align, bold: o.bold, fill: o.fill });
    }),
  }));
  return new Table({ columnWidths: cols, width: { size: W, type: WidthType.DXA }, rows: [hr, ...br] });
}

// ════════════════════════════════════════════════════════
// 1. 사업개요
// ════════════════════════════════════════════════════════
function section1() {
  const out = [heading('1. 사업개요')];
  const org = orgs.find((o) => o.코드 === ORG) || {};
  const rows = [
    ['사업명', { t: base.사업.사업명, span: 3 }],
    ['세부사업명', { t: base.사업.세부사업명 || '-', span: 3 }],
    ['사업기간', { t: `${kdate(base.사업.사업기간.개시일)} ~ ${kdate(base.사업.사업기간.종료일)}`, span: 3 }],
    ['기 관 명', base.사업.기관명 || org.명칭, '총괄책임자', `${base.사업.총괄책임자 || ''}   (인)`],
    ['총 사업예산', { t: `${num(base.사업.총사업비.금액)} 원`, span: 3 }],
  ];
  const cols = [1400, 3400, 1400, 3439];
  out.push(new Table({
    columnWidths: cols,
    width: { size: W, type: WidthType.DXA },
    rows: rows.map((row) => {
      const cells = []; let ci = 0;
      row.forEach((c) => {
        const o = typeof c === 'object' ? c : { t: c };
        const span = o.span || 1;
        const w = cols.slice(ci, ci + span).reduce((a, b) => a + b, 0);
        cells.push(cell(o.t, {
          w, span: span > 1 ? span : undefined,
          align: ci === 0 || (ci === 2 && !o.span) ? 'c' : 'l',
          bold: ci === 0 || (ci === 2 && !o.span),
          fill: ci === 0 || (ci === 2 && !o.span) ? 'D9E2F3' : undefined,
        }));
        ci += span;
      });
      return new TableRow({ children: cells });
    }),
  }));

  out.push(p(''));
  out.push(sub('교부 내역'));
  const years = base.연도별교부내역 || [];
  const h = [''], row1 = [{ t: '국비', bold: true, align: 'c', fill: 'D9E2F3' }],
    row2 = [{ t: '지방비', bold: true, align: 'c', fill: 'D9E2F3' }],
    row3 = [{ t: '계', bold: true, align: 'c', fill: 'F2F2F2' }];
  years.forEach((y) => {
    h.push(`'${String(y.연도).slice(2)}년`);
    row1.push({ t: num(y.국비), align: 'r' });
    row2.push({ t: num(y.지방비), align: 'r' });
    row3.push({ t: num(y.국비 + y.지방비), align: 'r', bold: true, fill: 'F2F2F2' });
  });
  h.push('합계');
  const tg = years.reduce((s, y) => s + y.국비, 0), tl = years.reduce((s, y) => s + y.지방비, 0);
  row1.push({ t: num(tg), align: 'r', bold: true, fill: 'F2F2F2' });
  row2.push({ t: num(tl), align: 'r', bold: true, fill: 'F2F2F2' });
  row3.push({ t: num(tg + tl), align: 'r', bold: true, fill: 'F2F2F2' });
  out.push(table(h, [row1, row2, row3], [14, ...years.map(() => 20), 26]));
  return out;
}

// ════════════════════════════════════════════════════════
// 2. 집행내역 (연도별)
// ════════════════════════════════════════════════════════
function section2() {
  const out = [heading('2. 집행내역')];
  const years = (base.연도별교부내역 || []).map((y) => y.연도);
  const byYear = {};
  for (const e of all) {
    const y = Number(e.집행일자.slice(0, 4));
    byYear[y] = byYear[y] || { 국비: 0, 지방비: 0 };
    if (e.재원 === '국비') byYear[y].국비 += e.집행금액;
    else if (e.재원 === '도비' || e.재원 === '시비') byYear[y].지방비 += e.집행금액;
  }
  const h = [''], row1 = [{ t: '국비', bold: true, align: 'c', fill: 'D9E2F3' }],
    row2 = [{ t: '지방비', bold: true, align: 'c', fill: 'D9E2F3' }],
    row3 = [{ t: '계', bold: true, align: 'c', fill: 'F2F2F2' }];
  let tg = 0, tl = 0;
  years.forEach((y) => {
    const v = byYear[y] || { 국비: 0, 지방비: 0 };
    tg += v.국비; tl += v.지방비;
    h.push(`'${String(y).slice(2)}년`);
    row1.push({ t: num(v.국비), align: 'r' });
    row2.push({ t: num(v.지방비), align: 'r' });
    row3.push({ t: num(v.국비 + v.지방비), align: 'r', bold: true, fill: 'F2F2F2' });
  });
  h.push('합계');
  row1.push({ t: num(tg), align: 'r', bold: true, fill: 'F2F2F2' });
  row2.push({ t: num(tl), align: 'r', bold: true, fill: 'F2F2F2' });
  row3.push({ t: num(tg + tl), align: 'r', bold: true, fill: 'F2F2F2' });
  out.push(table(h, [row1, row2, row3], [14, ...years.map(() => 20), 26]));
  return out;
}

// ════════════════════════════════════════════════════════
// 3. 보조비목별 총괄명세서
// ════════════════════════════════════════════════════════
function section3() {
  const out = [heading('3. 보조비목별 총괄명세서')];
  const exec = {};
  for (const e of all) exec[`${e.비목코드}-${e.세목코드}`] = (exec[`${e.비목코드}-${e.세목코드}`] || 0) + e.집행금액;

  const sorted = [...budget].sort((a, b) =>
    (비목순서.indexOf(a.비목코드) - 비목순서.indexOf(b.비목코드)) || a.세목코드.localeCompare(b.세목코드));

  let A = 0, B = 0;
  const rows = sorted.map((b) => {
    const key = `${b.비목코드}-${b.세목코드}`;
    const v = exec[key] || 0;
    A += b.예산집행계획; B += v;
    return [
      { t: `${b.보조비목}(${b.비목코드})`, align: 'c' },
      { t: `${b.보조세목}(${b.세목코드})`, align: 'c' },
      { t: num(b.예산집행계획), align: 'r' },
      { t: num(v), align: 'r' },
      { t: num(b.예산집행계획 - v), align: 'r' },
      { t: pct(v, b.예산집행계획), align: 'c' },
    ];
  });
  rows.push([
    { t: '합계', align: 'c', bold: true, fill: 'F2F2F2', span: 2 },
    { t: '', fill: 'F2F2F2' },
    { t: num(A), align: 'r', bold: true, fill: 'F2F2F2' },
    { t: num(B), align: 'r', bold: true, fill: 'F2F2F2' },
    { t: num(A - B), align: 'r', bold: true, fill: 'F2F2F2' },
    { t: pct(B, A), align: 'c', bold: true, fill: 'F2F2F2' },
  ].filter((_, i) => i !== 1));

  // 합계행은 앞 2칸을 병합하지 않고 단순 표기(호환성 우선)
  const last = rows[rows.length - 1];
  rows[rows.length - 1] = [
    { t: '합계', align: 'c', bold: true, fill: 'F2F2F2' },
    { t: '', fill: 'F2F2F2' },
    last[1], last[2], last[3], last[4],
  ];

  out.push(table(
    ['보조비목', '보조세목', '예산집행계획(A)', '집행액(B)', '집행잔액(A-B)', '집행률(B/A)'],
    rows, [16, 18, 18, 18, 18, 12]
  ));
  out.push(p(`※ 집행액은 검토상태 '확정' 증빙 ${all.length}건의 합계이며, 미확정 증빙은 제외됨`,
    { size: 15, color: '595959', before: 80 }));
  return out;
}

// ════════════════════════════════════════════════════════
// 4. 보조비목별 일자별 집행내역
// ════════════════════════════════════════════════════════
function section4() {
  const out = [heading('4. 보조비목별 일자별 집행내역')];
  out.push(p(`(대상기간: ${kdate(FROM)} ~ ${kdate(TO)})`, { size: 15, color: '595959', after: 100 }));

  // 비목 → (세목, 일자) 로 묶어 지급방식을 합산 표기
  const groups = {};
  for (const e of inPeriod) {
    const g = groups[e.비목코드] = groups[e.비목코드] || { e, items: {} };
    const k = `${e.세목코드}|${e.집행일자}`;
    const it = g.items[k] = g.items[k] || { e, 금액: 0, 방식: new Set(), 목적: new Set() };
    it.금액 += e.집행금액;
    it.방식.add(e.지급방식);
    it.목적.add(e.사용목적.split('_')[0].slice(0, 40));
  }

  const rows = [];
  let total = 0;
  for (const code of 비목순서) {
    const g = groups[code]; if (!g) continue;
    const items = Object.values(g.items).sort((a, b) =>
      a.e.집행일자.localeCompare(b.e.집행일자) || a.e.세목코드.localeCompare(b.e.세목코드));
    let sum = 0;
    items.forEach((it, i) => {
      sum += it.금액;
      rows.push([
        { t: i === 0 ? 비목표기(g.e) : '', align: 'c' },
        { t: 세목표기(it.e), align: 'c' },
        { t: kdate(it.e.집행일자), align: 'c' },
        { t: num(it.금액), align: 'r' },
        { t: [...it.목적].join(', ') },
        { t: [...it.방식].join(', '), align: 'c' },
      ]);
    });
    total += sum;
    rows.push([
      { t: '소계', align: 'c', bold: true, fill: 'F2F2F2' },
      { t: '', fill: 'F2F2F2' }, { t: '', fill: 'F2F2F2' },
      { t: num(sum), align: 'r', bold: true, fill: 'F2F2F2' },
      { t: '', fill: 'F2F2F2' }, { t: '', fill: 'F2F2F2' },
    ]);
  }
  rows.push([
    { t: '합 계', align: 'c', bold: true, fill: 'D9E2F3' },
    { t: '', fill: 'D9E2F3' }, { t: '', fill: 'D9E2F3' },
    { t: num(total), align: 'r', bold: true, fill: 'D9E2F3' },
    { t: '', fill: 'D9E2F3' }, { t: '', fill: 'D9E2F3' },
  ]);

  out.push(table(
    ['보조비목', '보조세목', '집행일자', '집행금액', '사용목적', '지급방식'],
    rows, [13, 13, 11, 13, 36, 14]
  ));
  return out;
}

// ════════════════════════════════════════════════════════
// 4-1. 보조비목별 세부집행내역
// ════════════════════════════════════════════════════════
function section41() {
  const out = [heading('4-1. 보조비목별 세부집행내역')];

  const present = 비목순서.filter((c) => inPeriod.some((e) => e.비목코드 === c));
  present.forEach((code, idx) => {
    const list = inPeriod.filter((e) => e.비목코드 === code)
      .sort((a, b) => a.집행일자.localeCompare(b.집행일자));
    const 비목명 = list[0].보조비목;
    const t = 유형(code);

    // 세부구분이 있으면 하위 절로 분할
    const subs = [...new Set(list.map((e) => e.세부구분 || null))];
    const useSub = subs.length > 1 || (subs.length === 1 && subs[0] !== null && code === '210');
    const groups = useSub
      ? [...new Set(list.map((e) => e.세부구분 || e.보조세목))]
        .map((name) => ({ name, items: list.filter((e) => (e.세부구분 || e.보조세목) === name) }))
      : [{ name: null, items: list }];

    out.push(sub(`${idx + 1}) ${비목명}`));

    groups.forEach((g, gi) => {
      if (g.name) out.push(p(`${idx + 1}-${gi + 1}) ${비목명}(${g.name})`,
        { size: 18, bold: true, before: 140, after: 60 }));

      const isPerson = (e) => e.지급처.구분 === '개인';
      const mixed = t === '혼합' || (t === '개인' ? false : g.items.some(isPerson));

      let headers, weights, rows;
      if (t === '개인') {
        headers = ['연번', '집행일자', '성명', '생년월일', '참여율', '집행금액', '사용목적', '지급방식'];
        weights = [6, 11, 10, 11, 8, 13, 29, 12];
        rows = g.items.map((e, i) => [
          { t: i + 1, align: 'c' }, { t: kdate(e.집행일자), align: 'c' },
          { t: e.지급처.명칭, align: 'c' }, { t: e.지급처.생년월일 || '', align: 'c' },
          { t: e.지급처.참여율 != null ? e.지급처.참여율 + '%' : '', align: 'c' },
          { t: num(e.집행금액), align: 'r' }, { t: e.사용목적 },
          { t: e.지급방식, align: 'c' },
        ]);
      } else if (mixed) {
        headers = ['연번', '집행일자', '성명/지급처', '생년월일\n사업자등록번호', '참여율', '집행금액', '사용목적', '지급방식'];
        weights = [6, 11, 13, 13, 7, 13, 25, 12];
        rows = g.items.map((e, i) => [
          { t: i + 1, align: 'c' }, { t: kdate(e.집행일자), align: 'c' },
          { t: e.지급처.명칭, align: 'c' },
          { t: e.지급처.생년월일 || e.지급처.사업자등록번호 || '', align: 'c' },
          { t: e.지급처.참여율 != null ? e.지급처.참여율 + '%' : '', align: 'c' },
          { t: num(e.집행금액), align: 'r' }, { t: e.사용목적 },
          { t: e.지급방식, align: 'c' },
        ]);
      } else {
        headers = ['연번', '집행일자', '지급처', '사업자등록번호', '집행금액', '사용목적', '지급방식'];
        weights = [6, 11, 17, 13, 14, 27, 12];
        rows = g.items.map((e, i) => [
          { t: i + 1, align: 'c' }, { t: kdate(e.집행일자), align: 'c' },
          { t: e.지급처.명칭 }, { t: e.지급처.사업자등록번호 || '', align: 'c' },
          { t: num(e.집행금액), align: 'r' }, { t: e.사용목적 },
          { t: e.지급방식, align: 'c' },
        ]);
      }
      const sumAmt = g.items.reduce((s, e) => s + e.집행금액, 0);
      const amtIdx = headers.indexOf('집행금액');
      const totalRow = headers.map((_, i) =>
        i === 0 ? { t: '합 계', align: 'c', bold: true, fill: 'F2F2F2' }
          : i === amtIdx ? { t: num(sumAmt), align: 'r', bold: true, fill: 'F2F2F2' }
            : { t: '', fill: 'F2F2F2' });
      rows.push(totalRow);
      out.push(table(headers, rows, weights));
    });
  });
  return out;
}

// ════════════════════════════════════════════════════════
// 조립
// ════════════════════════════════════════════════════════
const 미확정 = [];
if (!base.사업.사업기간.confirmed) 미확정.push('사업기간');
if (!base.사업.총사업비.confirmed) 미확정.push('총사업비');
(base.연도별교부내역 || []).forEach((y) => { if (y.confirmed === false) 미확정.push(`${y.연도}년 교부액`); });

const org = orgs.find((o) => o.코드 === ORG) || {};
const children = [
  new Paragraph({
    spacing: { after: 200 },
    children: [
      r('별첨 4  ', { size: 18, bold: true }),
      r(`보조사업 집행결과 제출 양식 ( ${org.명칭 || ORG} )`, { size: 22, bold: true }),
    ],
  }),
];
if (미확정.length) {
  children.push(new Paragraph({
    spacing: { after: 160 },
    shading: { type: ShadingType.CLEAR, fill: 'FFF2CC', color: 'auto' },
    children: [r(`※ [초안] 기준정보 미확정: ${미확정.join(', ')} — 협약서·교부결정통지서 확정 후 재생성 필요`,
      { size: 16, bold: true, color: 'C00000' })],
  }));
}
children.push(
  ...section1(), ...section2(), ...section3(), ...section4(), ...section41(),
);

const doc = new Document({
  styles: { default: { document: { run: { font: FONT, size: 18 } } } },
  sections: [{
    properties: {
      page: {
        margin: {
          top: convertMillimetersToTwip(18), bottom: convertMillimetersToTwip(18),
          left: convertMillimetersToTwip(20), right: convertMillimetersToTwip(20),
        },
      },
    },
    footers: {
      default: new Footer({
        children: [new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ children: ['- ', PageNumber.CURRENT, ' -'], font: FONT, size: 16 })],
        })],
      }),
    },
    children,
  }],
});

const outDir = path.join(ROOT, 'output');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `보조사업_집행결과_제출_${ORG}_${TO.replace(/-/g, '')}.docx`);
Packer.toBuffer(doc).then((buf) => {
  fs.writeFileSync(outFile, buf);
  console.log(`생성 완료: ${path.relative(ROOT, outFile)}`);
  console.log(`  기관 ${org.명칭 || ORG} / 확정증빙 ${all.length}건 / 대상기간 내 ${inPeriod.length}건`);
  console.log(`  집행액 합계 ${num(all.reduce((s, e) => s + e.집행금액, 0))}원`);
  if (미확정.length) console.log(`  ⚠ 기준정보 미확정: ${미확정.join(', ')} — 초안 워터마크 표시됨`);
});
