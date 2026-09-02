#!/usr/bin/env node
/**
 * 준공서류 생성기
 *
 * data/completion.json(준공대장) + contracts.json + baseline.json 에서
 * 준공 단계에 필요한 문서를 만든다. 정산 쪽 generate-report.js 와 짝을 이룬다.
 *
 *   1. 준공서류 확보 현황표     — 어느 단위사업의 무슨 문서가 없는지
 *   2. 준공검사조서             — 단위사업별
 *   3. 검수조서                 — 단위사업별
 *   4. 시설물 인계·인수서       — 단위사업별
 *
 * 사용법:
 *   node scripts/generate-completion.js                 현황표만
 *   node scripts/generate-completion.js --id CP-2026-0007   해당 건의 검사·검수·인계 서류
 *   node scripts/generate-completion.js --all           준공완료 건 전체
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
const W = 9639;
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const ONLY = arg('--id', null);
const ALL = argv.includes('--all');

const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const base = read('data/baseline.json');
const comp = read('data/completion.json').레코드;
const contracts = read('data/contracts.json').레코드;
const docsets = read('codes/completion-documents.json').유형별필수문서;
const subs = read('codes/subprojects.json').코드;
const subName = (c) => (subs.find((s) => s.코드 === c) || {}).명칭 || c;

const kdate = (s) => (s ? String(s).replace(/-/g, '.') : '        .     .     .');
const 오늘 = new Date().toISOString().slice(0, 10);

// ── 문서 조립 도구 ──────────────────────────────────────
const r = (t, o = {}) => new TextRun({
  text: String(t), font: FONT, size: o.size || 20, bold: !!o.bold, color: o.color || '000000',
});
const p = (t, o = {}) => new Paragraph({
  alignment: o.align || AlignmentType.LEFT,
  spacing: { before: o.before ?? 40, after: o.after ?? 40, line: o.size > 24 ? undefined : 300 },
  indent: o.left ? { left: o.left } : undefined,
  children: [r(t, o)],
});
const title = (t) => new Paragraph({
  alignment: AlignmentType.CENTER, spacing: { before: 200, after: 320 },
  children: [new TextRun({ text: t, font: FONT, size: 40, bold: true, characterSpacing: 60 })],
});
const h2 = (t) => new Paragraph({
  spacing: { before: 300, after: 120 },
  border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: '1F3864', space: 3 } },
  children: [r(t, { size: 24, bold: true, color: '1F3864' })],
});
function cell(t, o = {}) {
  return new TableCell({
    width: { size: o.w, type: WidthType.DXA },
    columnSpan: o.span, rowSpan: o.rspan,
    verticalAlign: VerticalAlign.CENTER,
    margins: { top: 60, bottom: 60, left: 90, right: 90 },
    shading: o.fill ? { type: ShadingType.CLEAR, fill: o.fill, color: 'auto' } : undefined,
    children: String(t).split('\n').map((line) => new Paragraph({
      alignment: o.align === 'c' ? AlignmentType.CENTER : o.align === 'r' ? AlignmentType.RIGHT : AlignmentType.LEFT,
      spacing: { before: 20, after: 20 },
      children: [r(line, { size: o.size || 18, bold: o.bold, color: o.color })],
    })),
  });
}
function table(headers, rows, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  const cols = weights.map((x) => Math.round(W * x / sum));
  cols[cols.length - 1] = W - cols.slice(0, -1).reduce((a, b) => a + b, 0);
  const body = rows.map((row) => new TableRow({
    children: row.map((c, i) => {
      const o = typeof c === 'object' && c !== null ? c : { t: c };
      return cell(o.t, { w: cols[i], align: o.align, bold: o.bold, fill: o.fill, color: o.color, span: o.span });
    }),
  }));
  const head = headers ? [new TableRow({
    tableHeader: true,
    children: headers.map((h, i) => cell(h, { w: cols[i], align: 'c', bold: true, fill: 'D9E2F3' })),
  })] : [];
  return new Table({ columnWidths: cols, width: { size: W, type: WidthType.DXA }, rows: [...head, ...body] });
}
/** 라벨-값 2열 표 */
function kv(rows, labelW = 20) {
  return table(null, rows.map(([k, v]) => [
    { t: k, align: 'c', bold: true, fill: 'F2F2F2' }, { t: v },
  ]), [labelW, 100 - labelW]);
}
function 서명란(항목) {
  return table(null, [항목.map((x) => ({ t: x + '\n\n\n(서명 또는 인)', align: 'c' }))],
    항목.map(() => 100 / 항목.length));
}
function build(children, file) {
  const doc = new Document({
    styles: { default: { document: { run: { font: FONT, size: 20 } } } },
    sections: [{
      properties: { page: { margin: {
        top: convertMillimetersToTwip(20), bottom: convertMillimetersToTwip(20),
        left: convertMillimetersToTwip(20), right: convertMillimetersToTwip(20) } } },
      footers: { default: new Footer({ children: [new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ children: ['- ', PageNumber.CURRENT, ' -'], font: FONT, size: 16, color: '595959' })],
      })] }) },
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

// ══════════════════════════════════════════════════════════
// 1. 준공서류 확보 현황표
// ══════════════════════════════════════════════════════════
function 현황표() {
  const c = [];
  c.push(p('아산시 강소형 스마트시티 조성사업', { align: AlignmentType.CENTER, size: 22, color: '2E5496', bold: true }));
  c.push(title('준공서류 확보 현황'));
  c.push(kv([
    ['작성일', kdate(오늘)],
    ['사업기간', `${kdate(base.사업.사업기간.개시일)} ~ ${kdate(base.사업.사업기간.종료일)}`],
    ['작성', '㈜제일엔지니어링종합건축사사무소 PMO / 상무 이성호'],
  ]));

  // 총괄
  let 필수 = 0, 확보 = 0;
  comp.forEach((x) => {
    const req = x.문서.filter((d) => d.필수여부 !== false);
    필수 += req.length;
    확보 += req.filter((d) => ['제출완료', '확정'].includes(d.상태)).length;
  });
  c.push(h2('Ⅰ. 총괄'));
  c.push(table(['구　분', '단위공사', '필수문서', '확보', '결손', '확보율'], [[
    { t: '전　체', align: 'c', bold: true },
    { t: comp.length + '건', align: 'c' },
    { t: 필수 + '종', align: 'c' },
    { t: 확보 + '종', align: 'c' },
    { t: (필수 - 확보) + '종', align: 'c', color: 'C00000', bold: true },
    { t: 필수 ? ((확보 / 필수) * 100).toFixed(1) + '%' : '-', align: 'c', bold: true },
  ]], [18, 18, 16, 16, 16, 16]));
  c.push(p('※ 준공검사 완료 후에도 필수문서가 결손이면 정산 검증에서 지적됨(검증규칙 R-09)',
    { size: 17, color: '595959', before: 80 }));

  // 단위공사별
  c.push(h2('Ⅱ. 단위공사별 현황'));
  c.push(table(['준공ID', '단위사업', '단위공사', '유형', '수행사', '진도', '문서'],
    comp.map((x) => {
      const req = x.문서.filter((d) => d.필수여부 !== false);
      const got = req.filter((d) => ['제출완료', '확정'].includes(d.상태)).length;
      const 부족 = req.length - got;
      return [
        { t: x.준공ID, align: 'c' },
        { t: subName(x.단위사업), align: 'c' },
        x.명칭,
        { t: x.유형, align: 'c' },
        { t: x.수행사 || '-', align: 'c' },
        { t: (x.물리적진도율 ?? 0) + '%', align: 'c' },
        { t: `${got}/${req.length}`, align: 'c', bold: 부족 > 0, color: 부족 > 0 ? 'C00000' : '1A6B3C' },
      ];
    }), [11, 13, 26, 10, 16, 8, 8]));

  // 결손 상세
  c.push(h2('Ⅲ. 결손 문서 상세'));
  const 결손목록 = comp.map((x) => {
    const miss = x.문서.filter((d) => d.필수여부 !== false && !['제출완료', '확정'].includes(d.상태));
    return { x, miss };
  }).filter((o) => o.miss.length);

  if (!결손목록.length) c.push(p('결손 없음', { left: 300 }));
  else 결손목록.forEach((o) => {
    c.push(p(`□ ${o.x.명칭}  (${o.x.준공ID})`, { bold: true, before: 180, size: 21 }));
    c.push(table(['No', '결손 문서', '작성주체', '비고'],
      o.miss.map((d, i) => [
        { t: i + 1, align: 'c' }, d.문서명,
        { t: d.작성주체 || o.x.수행사 || '-', align: 'c' },
        d.보완사유 || '',
      ]), [7, 40, 23, 30]));
  });

  // 유형별 필수문서 정의
  c.push(new Paragraph({ pageBreakBefore: true, children: [r('')] }));
  c.push(h2('붙임. 유형별 준공 필수문서'));
  Object.entries(docsets).forEach(([유형, list]) => {
    c.push(p(`□ ${유형} (${list.length}종)`, { bold: true, before: 160 }));
    c.push(p(list.join(' · '), { left: 400, size: 18 }));
  });

  return build(c, '준공서류_확보현황_' + 오늘.replace(/-/g, '') + '.docx');
}

// ══════════════════════════════════════════════════════════
// 2~4. 단위공사별 준공 서류
// ══════════════════════════════════════════════════════════
function 단위서류(x) {
  const ct = contracts.find((c) => c.계약ID === x.계약ID) || {};
  const 공통 = [
    ['사 업 명', base.사업.사업명],
    ['단위사업', subName(x.단위사업)],
    ['공 사 명', x.명칭],
    ['계약상대자', x.수행사 || (ct.계약상대자 || {}).상호 || ''],
    ['계약번호', x.계약ID || ''],
    ['계약금액', ct.계약금액 ? ct.계약금액.toLocaleString('ko-KR') + '원' : ''],
    ['계약일자', kdate(ct.계약일)],
    ['준공기한', kdate(ct.준공예정일)],
  ];
  const files = [];

  // ── 준공검사조서 ──
  {
    const c = [];
    c.push(title('준 공 검 사 조 서'));
    c.push(kv(공통));
    c.push(h2('1. 검사 결과'));
    c.push(table(['검사 항목', '검사 내용', '판정'], [
      ['계약이행 완료 여부', '과업지시서·설계도서에 따른 이행 완료 여부', { t: '적합 / 부적합', align: 'c' }],
      ['수량 및 규격', '준공내역서 대비 수량·규격 일치 여부', { t: '적합 / 부적합', align: 'c' }],
      ['품질 상태', '시험성적서·성능시험 결과 규격 충족 여부', { t: '적합 / 부적합', align: 'c' }],
      ['시운전 결과', '통합 시운전 및 정상 가동 확인', { t: '적합 / 부적합 / 해당없음', align: 'c' }],
      ['안전·법령 준수', '관계법령 인허가 및 안전조치 이행 여부', { t: '적합 / 부적합', align: 'c' }],
    ], [22, 56, 22]));
    c.push(h2('2. 지적사항 및 조치'));
    c.push(table(['No', '지적사항', '조치내용', '조치일'],
      [1, 2, 3].map((i) => [{ t: i, align: 'c' }, '', '', '']), [8, 42, 34, 16]));
    c.push(h2('3. 검사 의견'));
    c.push(table(null, [[{ t: '\n\n\n', span: 1 }]], [100]));
    c.push(p('위와 같이 준공검사를 실시하고 그 결과를 보고합니다.',
      { align: AlignmentType.CENTER, before: 400, size: 21 }));
    c.push(p(kdate(오늘), { align: AlignmentType.CENTER, before: 200, after: 300, size: 21 }));
    c.push(서명란(['검사자\n(PMO)', '입회자\n(수행사)', '확인\n(아산시)']));
    files.push(build(c, `준공검사조서_${x.준공ID}_${x.명칭.slice(0, 14)}.docx`));
  }

  // ── 검수조서 ──
  {
    const c = [];
    c.push(title('검 수 조 서'));
    c.push(kv(공통));
    c.push(h2('1. 검수 내역'));
    c.push(table(['No', '품명 / 항목', '규격', '단위', '수량', '검수결과'],
      [1, 2, 3, 4, 5].map((i) => [{ t: i, align: 'c' }, '', '', { t: '', align: 'c' }, { t: '', align: 'c' }, { t: '', align: 'c' }]),
      [7, 33, 24, 10, 10, 16]));
    c.push(h2('2. 검수 확인'));
    c.push(table(['확인 항목', '내　　용', '확인'], [
      ['납품·설치 완료', '계약 수량 전량 납품 및 설치 완료', { t: '□', align: 'c' }],
      ['규격 일치', '계약 규격과 실물 일치(모델·S/N 대조)', { t: '□', align: 'c' }],
      ['정상 작동', '전원 인가 및 기능 동작 확인', { t: '□', align: 'c' }],
      ['부속·매뉴얼', '부속품·운영매뉴얼·보증서 인수', { t: '□', align: 'c' }],
      ['자산 등재', '중요재산 대장 등재 및 라벨 부착', { t: '□', align: 'c' }],
    ], [22, 62, 16]));
    c.push(p('※ 취득가액 50만원 초과 자산은 취득 후 15일 이내 중요재산 보고 의무(통합관리지침 §46①)',
      { size: 17, color: 'C00000', before: 80 }));
    c.push(p('위와 같이 검수하였음을 확인합니다.', { align: AlignmentType.CENTER, before: 400, size: 21 }));
    c.push(p(kdate(오늘), { align: AlignmentType.CENTER, before: 200, after: 300, size: 21 }));
    c.push(서명란(['검수자', '입회자', '확인']));
    files.push(build(c, `검수조서_${x.준공ID}_${x.명칭.slice(0, 14)}.docx`));
  }

  // ── 시설물 인계·인수서 ──
  {
    const c = [];
    c.push(title('시설물 인계 · 인수서'));
    c.push(kv(공통.concat([['인계자', x.수행사 || ''], ['인수자', '아산시']])));
    c.push(h2('1. 인계 대상'));
    c.push(table(['No', '시설·자산명', '규격 / 수량', '설치장소', '자산ID'],
      [1, 2, 3, 4, 5].map((i) => [{ t: i, align: 'c' }, '', '', '', { t: '', align: 'c' }]),
      [7, 30, 20, 27, 16]));
    c.push(h2('2. 인계 문서'));
    const 세트 = docsets[x.유형] || [];
    c.push(table(['No', '문서명', '부수', '인수확인'],
      세트.map((d, i) => [{ t: i + 1, align: 'c' }, d, { t: '1', align: 'c' }, { t: '□', align: 'c' }]),
      [8, 56, 16, 20]));
    c.push(h2('3. 하자담보'));
    c.push(kv([
      ['하자담보기간', ct.보증 && ct.보증.하자담보기간_개월 ? ct.보증.하자담보기간_개월 + '개월' : '        개월'],
      ['보증기간 만료', kdate(ct.보증 && ct.보증.보증기간만료일)],
      ['하자보수보증', '□ 증권  □ 현금  □ 면제'],
    ]));
    c.push(h2('4. 운영·유지관리'));
    c.push(kv([
      ['운영주체', ''],
      ['유지관리 책임', ''],
      ['운영 개시일', '        .     .     .'],
      ['운영의무 기간', '준공일로부터 3년 (협약 제14조②)'],
    ]));
    c.push(p('위 시설물 및 문서를 이상 없이 인계·인수하였음을 확인합니다.',
      { align: AlignmentType.CENTER, before: 360, size: 21 }));
    c.push(p(kdate(오늘), { align: AlignmentType.CENTER, before: 200, after: 300, size: 21 }));
    c.push(서명란(['인계자\n(수행사)', '인수자\n(아산시)', '입회자\n(PMO)']));
    files.push(build(c, `인계인수서_${x.준공ID}_${x.명칭.slice(0, 14)}.docx`));
  }

  return Promise.all(files);
}

// ══════════════════════════════════════════════════════════
(async () => {
  console.log('준공서류 생성');
  await 현황표();

  let 대상 = [];
  if (ONLY) 대상 = comp.filter((x) => x.준공ID === ONLY);
  else if (ALL) 대상 = comp.filter((x) => ['준공검사대기', '준공완료', '인계완료'].includes(x.상태));

  if (ONLY && !대상.length) { console.error(`준공ID ${ONLY} 를 찾을 수 없습니다.`); process.exit(1); }
  for (const x of 대상) {
    console.log(`\n■ ${x.준공ID} ${x.명칭}`);
    await 단위서류(x);
  }

  const 필수 = comp.reduce((s, x) => s + x.문서.filter((d) => d.필수여부 !== false).length, 0);
  const 확보 = comp.reduce((s, x) => s + x.문서.filter((d) => d.필수여부 !== false && ['제출완료', '확정'].includes(d.상태)).length, 0);
  console.log(`\n단위공사 ${comp.length}건 · 필수문서 ${필수}종 · 확보 ${확보}종 (${((확보 / 필수) * 100).toFixed(1)}%)`);
  if (!ONLY && !ALL) console.log('개별 서류는 --id CP-2026-0007 또는 --all 로 생성합니다.');
})().catch((e) => { console.error(e); process.exit(1); });
