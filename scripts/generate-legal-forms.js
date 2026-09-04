#!/usr/bin/env node
/**
 * 법정서식 4종 생성기 — 「보조사업 실적보고서 및 정산보고서 작성지침」
 *
 *   별지 제1호  실적보고서
 *   별지 제2호  정산보고서
 *   별지 제3호  보조비목·보조세목별 총괄명세서   (정산보고서 첨부)
 *   별지 제4호  일자별 집행명세서                (정산보고서 첨부)
 *
 * 별첨4(집행결과 제출 양식)은 이 사업의 자체 양식이고, 이 파일은 보조금법령상
 * 법정서식이다. 둘 다 필요하다 — 자체 양식은 국토부·협회 제출용, 법정서식은
 * 보조금법 제27조에 따른 실적·정산 보고용.
 *
 * 사업비를 보조금·지방자치단체부담금·자기부담금으로 구분 작성한다(작성지침 §4④).
 *
 * 사용법:
 *   node scripts/generate-legal-forms.js --org JEIL
 *   node scripts/generate-legal-forms.js --org JEIL --status 확정,제출완료
 */

const fs = require('fs');
const path = require('path');
const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  WidthType, ShadingType, AlignmentType, BorderStyle, VerticalAlign,
  Footer, PageNumber, PageBreak, convertMillimetersToTwip,
} = require('docx');

const ROOT = path.resolve(__dirname, '..');
const FONT = '맑은 고딕';
const W = 9639;
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const ORG = arg('--org', 'JEIL');
const STATUS = arg('--status', '확정,제출완료,검토중,보완필요').split(',').map((s) => s.trim());

const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const base = read('data/baseline.json');
const budget = read('data/budget.json').레코드;
const codes = read('codes/expense-categories.json');
const orgs = read('codes/organizations.json').코드;
const 기관명 = (orgs.find((o) => o.코드 === ORG) || {}).명칭 || ORG;

const all = read('data/evidence.json').레코드.filter((e) => e.기관 === ORG && STATUS.includes(e.검토상태));

const num = (n) => (n ?? 0).toLocaleString('ko-KR');
const 천원 = (n) => Math.round((n ?? 0) / 1000).toLocaleString('ko-KR');
const kdate = (s) => (s ? String(s).replace(/-/g, '. ') + '.' : '        .    .    .');
const pct = (b, a) => (a > 0 ? ((b / a) * 100).toFixed(1) + '%' : '-');
const 비목순 = codes.비목.map((b) => b.코드);
const 오늘 = new Date().toISOString().slice(0, 10);

// ── 재원 분류: 국비=보조금, 도비+시비=지방자치단체부담금, 자기부담금 ──
function 재원3분류(list) {
  const r = { 보조금: 0, 지방비: 0, 자부담: 0 };
  for (const e of list) {
    if (e.재원 === '국비') r.보조금 += e.집행금액;
    else if (e.재원 === '도비' || e.재원 === '시비') r.지방비 += e.집행금액;
    else if (e.재원 === '자기부담금') r.자부담 += e.집행금액;
    else r.보조금 += e.집행금액; // 미구분은 잠정적으로 보조금으로
  }
  return r;
}

// ── 조립 도구 ────────────────────────────────────────────
const r = (t, o = {}) => new TextRun({ text: String(t), font: FONT, size: o.size || 19, bold: !!o.bold, color: o.color || '000000' });
const p = (t, o = {}) => new Paragraph({
  alignment: o.align || AlignmentType.LEFT,
  spacing: { before: o.before ?? 40, after: o.after ?? 40, line: (o.size || 19) > 26 ? undefined : 300 },
  indent: o.left ? { left: o.left } : undefined,
  children: [r(t, o)],
});
const 표제 = (t, 서식) => [
  new Paragraph({ alignment: AlignmentType.RIGHT, spacing: { after: 60 }, children: [r(`[${서식}]`, { size: 16, color: '595959' })] }),
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 120, after: 260 }, children: [new TextRun({ text: t, font: FONT, size: 34, bold: true, characterSpacing: 80 })] }),
];
const 절 = (t) => new Paragraph({ spacing: { before: 280, after: 120 }, children: [r(t, { size: 22, bold: true })] });

function cell(t, o = {}) {
  return new TableCell({
    width: { size: o.w, type: WidthType.DXA }, columnSpan: o.span, rowSpan: o.rspan,
    verticalAlign: VerticalAlign.CENTER,
    margins: { top: 44, bottom: 44, left: 70, right: 70 },
    shading: o.fill ? { type: ShadingType.CLEAR, fill: o.fill, color: 'auto' } : undefined,
    children: String(t).split('\n').map((line) => new Paragraph({
      alignment: o.align === 'c' ? AlignmentType.CENTER : o.align === 'r' ? AlignmentType.RIGHT : AlignmentType.LEFT,
      spacing: { before: 14, after: 14, line: 280 },
      children: [r(line, { size: o.size || 17, bold: o.bold, color: o.color })],
    })),
  });
}
function table(headers, rows, weights) {
  const s = weights.reduce((a, b) => a + b, 0);
  const cols = weights.map((x) => Math.round(W * x / s));
  cols[cols.length - 1] = W - cols.slice(0, -1).reduce((a, b) => a + b, 0);
  const body = rows.map((row) => {
    let idx = 0;
    return new TableRow({
      children: row.map((c) => {
        const o = typeof c === 'object' && c !== null ? c : { t: c };
        const span = o.span || 1;
        const wsum = cols.slice(idx, idx + span).reduce((a, b) => a + b, 0);
        idx += span;
        return cell(o.t, { w: wsum, align: o.align, bold: o.bold, fill: o.fill, color: o.color, span: o.span, rspan: o.rspan, size: o.size });
      }),
    });
  });
  const head = headers ? [new TableRow({ tableHeader: true, children: headers.map((h, i) => cell(h, { w: cols[i], align: 'c', bold: true, fill: 'D9E2F3' })) })] : [];
  return new Table({ columnWidths: cols, width: { size: W, type: WidthType.DXA }, rows: [...head, ...body] });
}
const kv = (rows, lw = 22) => table(null, rows.map((row) => {
  if (row.length === 2) return [{ t: row[0], align: 'c', bold: true, fill: 'F2F2F2' }, { t: row[1] }];
  return [{ t: row[0], align: 'c', bold: true, fill: 'F2F2F2' }, { t: row[1] }, { t: row[2], align: 'c', bold: true, fill: 'F2F2F2' }, { t: row[3] }];
}), rows[0] && rows[0].length === 4 ? [16, 34, 16, 34] : [lw, 100 - lw]);
const 빈칸 = (h = 3) => table(null, [[{ t: '\n'.repeat(h) }]], [100]);

// ── 미확정 경고 ──────────────────────────────────────────
const 미확정 = [];
if (!base.사업.사업기간.confirmed) 미확정.push('사업기간');
if (!base.사업.총사업비.confirmed) 미확정.push('총사업비');
const 재원미구분 = all.filter((e) => e.재원 === '미구분').length;

function 초안배너() {
  const msg = [];
  if (미확정.length) msg.push(`기준정보 미확정: ${미확정.join(', ')}`);
  if (재원미구분) msg.push(`재원 미구분 ${num(재원미구분)}건 — 보조금으로 잠정 분류됨`);
  if (!msg.length) return [];
  return [new Paragraph({
    spacing: { after: 160 }, shading: { type: ShadingType.CLEAR, fill: 'FFF2CC', color: 'auto' },
    children: [r('※ [초안] ' + msg.join(' / ') + ' — 확정 후 재생성 필요', { size: 16, bold: true, color: 'C00000' })],
  })];
}

// ════════════════════════════════════════════════════════
// 별지 제1호 — 실적보고서
// ════════════════════════════════════════════════════════
function 실적보고서() {
  const c = [];
  const 집행 = all.reduce((s, e) => s + e.집행금액, 0);
  const 재원 = 재원3분류(all);
  const 총 = base.사업.총사업비.금액;

  c.push(...표제('보조사업 실적보고서', '별지 제1호서식'));
  c.push(...초안배너());

  c.push(절('Ⅰ. 일반현황'));
  c.push(kv([
    ['보조사업자', 기관명, '대표자', '상무 이성호  (인)'],
    ['사 업 명', base.사업.사업명],
    ['세부사업명', base.사업.세부사업명 || '-'],
    ['사업기간', `${kdate(base.사업.사업기간.개시일)} ~ ${kdate(base.사업.사업기간.종료일)}`],
    ['소관부처', base.사업.소관부처 || '국토교통부', '전담기관', base.사업.전담기관 || '한국스마트도시협회'],
    ['제 출 일', kdate(오늘)],
  ]));

  c.push(절('Ⅱ. 보조사업 개요'));
  c.push(kv([['사업목적', '디지털 OASIS 구현을 통한 지역 경제 활성화 및 데이터 기반 스마트시티 조성']]));
  c.push(p('○ 추진방법', { bold: true, before: 140 }));
  c.push(빈칸(2));
  c.push(p('○ 추진실적', { bold: true, before: 140 }));
  c.push(빈칸(3));
  c.push(p('○ 사업성과', { bold: true, before: 140 }));
  c.push(빈칸(2));
  c.push(p('○ 성과 활용계획', { bold: true, before: 140 }));
  c.push(빈칸(2));

  c.push(절('Ⅲ. 수행목표 대비 실적'));
  c.push(table(['성과지표', '목표', '실적', '달성률', '비고'],
    [1, 2, 3, 4].map((i) => [{ t: '', align: 'c' }, { t: '', align: 'c' }, { t: '', align: 'c' }, { t: '', align: 'c' }, '']),
    [30, 16, 16, 14, 24]));
  c.push(p('※ 협약 성과지표를 기재하고 측정 결과를 첨부함', { size: 16, color: '595959', before: 60 }));

  c.push(절('Ⅳ. 사업비 집행결과'));
  c.push(p('(단위: 천원)', { align: AlignmentType.RIGHT, size: 16 }));
  c.push(table(
    ['구　분', '보조금(국비)', '지방자치단체\n부담금', '자기부담금', '계'],
    [
      [{ t: '사업비', align: 'c', bold: true }, { t: 천원(총 * 0.5), align: 'r' }, { t: 천원(총 * 0.5), align: 'r' }, { t: 천원(0), align: 'r' }, { t: 천원(총), align: 'r', bold: true }],
      [{ t: '집행액', align: 'c', bold: true }, { t: 천원(재원.보조금), align: 'r' }, { t: 천원(재원.지방비), align: 'r' }, { t: 천원(재원.자부담), align: 'r' }, { t: 천원(집행), align: 'r', bold: true }],
      [{ t: '집행률', align: 'c', bold: true, fill: 'F2F2F2' },
        { t: pct(재원.보조금, 총 * 0.5), align: 'c', fill: 'F2F2F2' },
        { t: pct(재원.지방비, 총 * 0.5), align: 'c', fill: 'F2F2F2' },
        { t: '-', align: 'c', fill: 'F2F2F2' },
        { t: pct(집행, 총), align: 'c', bold: true, fill: 'F2F2F2' }],
    ], [16, 22, 22, 18, 22]));
  c.push(p('※ 세부 집행내역은 정산보고서 별지 제3호·제4호서식에 따름', { size: 16, color: '595959', before: 60 }));

  c.push(...서명부('보조사업 실적을 위와 같이 보고합니다.'));
  return c;
}

// ════════════════════════════════════════════════════════
// 별지 제2호 — 정산보고서
// ════════════════════════════════════════════════════════
function 정산보고서() {
  const c = [];
  const 집행 = all.reduce((s, e) => s + e.집행금액, 0);
  const 재원 = 재원3분류(all);
  const 총 = base.사업.총사업비.금액;
  const 잔액 = 총 - 집행;

  c.push(...표제('보조사업 정산보고서', '별지 제2호서식'));
  c.push(...초안배너());

  c.push(절('Ⅰ. 일반현황'));
  c.push(kv([
    ['보조사업자', 기관명, '대표자', '상무 이성호  (인)'],
    ['사 업 명', base.사업.사업명],
    ['사업기간', `${kdate(base.사업.사업기간.개시일)} ~ ${kdate(base.사업.사업기간.종료일)}`],
    ['제 출 일', kdate(오늘)],
  ]));

  c.push(절('Ⅱ. 보조사업비 정산'));
  c.push(p('(단위: 천원)', { align: AlignmentType.RIGHT, size: 16 }));
  c.push(table(
    ['구　분', '보조금(국비)', '지방자치단체\n부담금', '자기부담금', '계'],
    [
      [{ t: '교부·확정액', align: 'c', bold: true }, { t: 천원(총 * 0.5), align: 'r' }, { t: 천원(총 * 0.5), align: 'r' }, { t: 천원(0), align: 'r' }, { t: 천원(총), align: 'r', bold: true }],
      [{ t: '사용액(집행)', align: 'c', bold: true }, { t: 천원(재원.보조금), align: 'r' }, { t: 천원(재원.지방비), align: 'r' }, { t: 천원(재원.자부담), align: 'r' }, { t: 천원(집행), align: 'r', bold: true }],
      [{ t: '집행잔액', align: 'c', bold: true }, { t: 천원(총 * 0.5 - 재원.보조금), align: 'r' }, { t: 천원(총 * 0.5 - 재원.지방비), align: 'r' }, { t: 천원(0 - 재원.자부담), align: 'r' }, { t: 천원(잔액), align: 'r', bold: true }],
      [{ t: '이　자', align: 'c', bold: true, fill: 'F2F2F2' }, { t: '', fill: 'F2F2F2' }, { t: '', fill: 'F2F2F2' }, { t: '', fill: 'F2F2F2' }, { t: '', fill: 'F2F2F2' }],
      [{ t: '반납액', align: 'c', bold: true, fill: 'F2F2F2' }, { t: '', fill: 'F2F2F2' }, { t: '', fill: 'F2F2F2' }, { t: '', fill: 'F2F2F2' }, { t: '', fill: 'F2F2F2' }],
    ], [16, 22, 22, 18, 22]));
  c.push(p('※ 반납액 = 집행잔액 + 발생이자 (통합관리지침 §26)', { size: 16, color: '595959', before: 60 }));

  c.push(절('Ⅲ. 정산 결과 요약'));
  c.push(kv([
    ['총사업비', `${num(총)}원`, '집행액', `${num(집행)}원`],
    ['집행잔액', `${num(잔액)}원`, '집행률', pct(집행, 총)],
    ['증빙 건수', `${num(all.length)}건`, '정산 기준일', kdate(오늘)],
  ]));

  c.push(절('Ⅳ. 첨부서류'));
  c.push(table(['No', '첨　부　서　류', '해당'],
    [
      ['1', '별지 제3호서식 — 보조비목·보조세목별 총괄명세서', { t: '○', align: 'c' }],
      ['2', '별지 제4호서식 — 일자별 집행명세서', { t: '○', align: 'c' }],
      ['3', '보조금 전용계좌 거래내역', { t: '□', align: 'c' }],
      ['4', '정산보고서 검증보고서 (교부액 1억원 이상)', { t: '□', align: 'c' }],
      ['5', '집행잔액·이자 반납 영수증', { t: '□', align: 'c' }],
    ], [8, 78, 14]));

  c.push(...서명부('위와 같이 보조사업비를 정산하여 보고합니다.'));
  return c;
}

// ════════════════════════════════════════════════════════
// 별지 제3호 — 보조비목·보조세목별 총괄명세서
// ════════════════════════════════════════════════════════
function 총괄명세서() {
  const c = [];
  c.push(...표제('보조비목·보조세목별 총괄명세서', '별지 제3호서식'));
  c.push(...초안배너());
  c.push(kv([['보조사업자', 기관명, '사 업 명', base.사업.사업명]]));
  c.push(p('(단위: 원)', { align: AlignmentType.RIGHT, size: 16, before: 100 }));

  const 집행 = {};
  for (const e of all) 집행[`${e.비목코드}-${e.세목코드}`] = (집행[`${e.비목코드}-${e.세목코드}`] || 0) + e.집행금액;
  const sorted = [...budget].sort((a, b) => (비목순.indexOf(a.비목코드) - 비목순.indexOf(b.비목코드)) || a.세목코드.localeCompare(b.세목코드));

  let A = 0, B = 0;
  const rows = sorted.map((b) => {
    const v = 집행[`${b.비목코드}-${b.세목코드}`] || 0; A += b.예산집행계획; B += v;
    return [
      { t: `${b.보조비목}(${b.비목코드})`, align: 'c' }, { t: `${b.보조세목}(${b.세목코드})`, align: 'c' },
      { t: num(b.예산집행계획), align: 'r' }, { t: num(v), align: 'r' },
      { t: num(b.예산집행계획 - v), align: 'r' }, { t: pct(v, b.예산집행계획), align: 'c' },
    ];
  });
  rows.push([
    { t: '합　계', align: 'c', bold: true, fill: 'F2F2F2' }, { t: '', fill: 'F2F2F2' },
    { t: num(A), align: 'r', bold: true, fill: 'F2F2F2' }, { t: num(B), align: 'r', bold: true, fill: 'F2F2F2' },
    { t: num(A - B), align: 'r', bold: true, fill: 'F2F2F2' }, { t: pct(B, A), align: 'c', bold: true, fill: 'F2F2F2' },
  ]);
  c.push(table(['보조비목', '보조세목', '예산액(A)', '집행액(B)', '잔액(A-B)', '집행률'], rows, [16, 18, 18, 18, 18, 12]));
  c.push(p(`※ 집행액은 검토상태 [${STATUS.join(', ')}] ${num(all.length)}건의 합계임`, { size: 16, color: '595959', before: 80 }));
  return c;
}

// ════════════════════════════════════════════════════════
// 별지 제4호 — 일자별 집행명세서
// ════════════════════════════════════════════════════════
function 일자별명세서() {
  const c = [];
  c.push(...표제('일자별 집행명세서', '별지 제4호서식'));
  c.push(...초안배너());
  c.push(kv([['보조사업자', 기관명, '사 업 명', base.사업.사업명]]));
  c.push(p(`(단위: 원 · 총 ${num(all.length)}건)`, { align: AlignmentType.RIGHT, size: 16, before: 100 }));

  const sorted = [...all].sort((a, b) => a.집행일자.localeCompare(b.집행일자) || (비목순.indexOf(a.비목코드) - 비목순.indexOf(b.비목코드)));
  let 합 = 0;
  const rows = sorted.map((e, i) => {
    합 += e.집행금액;
    return [
      { t: i + 1, align: 'c' }, { t: e.집행일자.replace(/-/g, '.'), align: 'c' },
      { t: `${e.보조비목}(${e.비목코드})`, align: 'c' }, { t: `${e.보조세목}(${e.세목코드})`, align: 'c' },
      { t: e.지급처.명칭, align: 'c' }, { t: num(e.집행금액), align: 'r' },
      { t: e.사용목적 }, { t: e.지급방식, align: 'c' },
    ];
  });
  rows.push([
    { t: '합 계', align: 'c', bold: true, fill: 'F2F2F2', span: 5 },
    { t: num(합), align: 'r', bold: true, fill: 'F2F2F2' },
    { t: '', fill: 'F2F2F2', span: 2 },
  ]);
  c.push(table(['No', '집행일자', '보조비목', '보조세목', '지급처', '집행금액', '사용목적', '지급방식'], rows, [5, 9, 12, 12, 14, 12, 24, 12]));
  return c;
}

// ── 서명부 ──────────────────────────────────────────────
function 서명부(문구) {
  return [
    p(문구, { align: AlignmentType.CENTER, before: 400, size: 21 }),
    p(kdate(오늘), { align: AlignmentType.CENTER, before: 200, after: 240, size: 21 }),
    p(`보조사업자 : ${기관명}`, { align: AlignmentType.CENTER, size: 20, bold: true }),
    p('상무  이 성 호  (인)', { align: AlignmentType.CENTER, size: 20, bold: true, after: 300 }),
    p('국토교통부장관 귀하', { align: AlignmentType.CENTER, size: 21, bold: true }),
  ];
}

// ── 빌드 ────────────────────────────────────────────────
function build(children, file) {
  const doc = new Document({
    styles: { default: { document: { run: { font: FONT, size: 19 } } } },
    sections: [{
      properties: { page: { margin: { top: convertMillimetersToTwip(20), bottom: convertMillimetersToTwip(20), left: convertMillimetersToTwip(20), right: convertMillimetersToTwip(20) } } },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: ['- ', PageNumber.CURRENT, ' -'], font: FONT, size: 16, color: '595959' })] })] }) },
      children,
    }],
  });
  return Packer.toBuffer(doc).then((b) => {
    const out = path.join(ROOT, 'output', file);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, b);
    console.log('  ' + file);
  });
}

(async () => {
  console.log(`법정서식 생성 — ${기관명} / 확정대상 ${all.length}건`);
  const d = 오늘.replace(/-/g, '');
  await build(실적보고서(), `[별지1호]실적보고서_${ORG}_${d}.docx`);
  await build(정산보고서(), `[별지2호]정산보고서_${ORG}_${d}.docx`);
  await build(총괄명세서(), `[별지3호]총괄명세서_${ORG}_${d}.docx`);
  await build(일자별명세서(), `[별지4호]일자별집행명세서_${ORG}_${d}.docx`);
  const 집행 = all.reduce((s, e) => s + e.집행금액, 0);
  console.log(`  집행액 ${num(집행)}원 · 집행률 ${pct(집행, base.사업.총사업비.금액)}`);
  if (미확정.length || 재원미구분) console.log(`  ⚠ 초안 — ${[...미확정, 재원미구분 ? '재원미구분' : ''].filter(Boolean).join(', ')}`);
})().catch((e) => { console.error(e); process.exit(1); });
