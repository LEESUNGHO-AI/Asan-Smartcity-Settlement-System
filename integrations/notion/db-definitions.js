/**
 * Notion DB 정의
 *
 * 선택지(select/multi_select options)는 손으로 적지 않는다.
 * schema/common.schema.json 의 열거값과 codes/*.json 에서 자동으로 끌어온다.
 * 스키마가 바뀌면 setup-databases.js 를 다시 돌리는 것만으로 Notion이 따라온다.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

const common = read('schema/common.schema.json').$defs;
const expense = read('codes/expense-categories.json');
const orgs = read('codes/organizations.json').코드;
const subs = read('codes/subprojects.json').코드;

const COLORS = ['blue', 'green', 'orange', 'purple', 'pink', 'yellow', 'brown', 'red', 'gray', 'default'];
const opts = (names) => ({
  options: names.map((n, i) => ({ name: String(n), color: COLORS[i % COLORS.length] })),
});
const enumOf = (def) => common[def].enum;

// ── 선택지 소스 ──────────────────────────────────────────
const 기관 = orgs.map((o) => o.코드);
const 단위사업 = subs.map((s) => s.코드);
const 보조비목 = enumOf('보조비목');
const 보조세목 = [...new Set(expense.비목.flatMap((b) => b.세목.map((s) => s.명칭)))];
const 세부구분 = [...new Set(expense.비목.flatMap((b) => b.세목.flatMap((s) => s.세부구분 || [])))];
const 재원 = enumOf('재원');
const 지급방식 = enumOf('지급방법');
const 증빙유형 = enumOf('증빙유형');
const 검토상태 = enumOf('검토상태');
const 재산구분 = enumOf('재산구분');
const 계약유형 = enumOf('계약유형');
const 계약방법 = enumOf('계약방법');

const T = {
  title: { title: {} },
  text: { rich_text: {} },
  num: { number: { format: 'number' } },
  won: { number: { format: 'won' } },
  pct: { number: { format: 'percent' } },
  date: { date: {} },
  check: { checkbox: {} },
  url: { url: {} },
  edited: { last_edited_time: {} },
  sel: (v) => ({ select: opts(v) }),
  multi: (v) => ({ multi_select: opts(v) }),
};

// ── DB 정의 ─────────────────────────────────────────────
const DATABASES = {
  evidence: {
    key: 'evidence',
    title: '정산증빙 DB',
    secret: 'NOTION_EVIDENCE_DB',
    sync: 'scripts/sync-notion.js',
    description: '보조사업 집행결과 제출 양식의 원천. data/evidence.json 과 1:1 대응. 정본은 GitHub.',
    properties: {
      '증빙ID': T.title,
      '기관': T.sel(기관),
      '단위사업': T.sel(단위사업),
      '보조비목': T.sel(보조비목),
      '보조세목': T.sel(보조세목),
      '세부구분': T.sel(세부구분),
      '재원': T.sel(재원),
      '계약ID': T.text,
      '지급처구분': T.sel(['사업자', '개인']),
      '지급처명': T.text,
      '사업자등록번호': T.text,
      '생년월일': T.text,
      '참여율': T.num,
      '집행일자': T.date,
      '집행금액': T.won,
      '공급가액': T.won,
      '부가세': T.won,
      '사용목적': T.text,
      '지급방식': T.sel(지급방식),
      '증빙유형': T.multi(증빙유형),
      '파일링크': T.url,
      '자산ID': T.text,
      '귀속월': T.text,
      '선금여부': T.check,
      '승인인력여부': T.check,
      '검토상태': T.sel(검토상태),
      '보완사유': T.text,
      '등록자': T.text,
      'Slack링크': T.url,
      '동기화일시': T.edited,
    },
  },

  contracts: {
    key: 'contracts',
    title: '계약대장 DB',
    secret: 'NOTION_CONTRACTS_DB',
    sync: null,
    description: '통합관리지침 §21~22 준수 여부 판정 근거. data/contracts.json 대응.',
    properties: {
      '계약ID': T.title,
      '기관': T.sel(기관),
      '단위사업': T.sel(단위사업),
      '계약명': T.text,
      '계약유형': T.sel(계약유형),
      '계약방법': T.sel(계약방법),
      '추정가격': T.won,
      '계약금액': T.won,
      '낙찰차액': T.won,
      '계약일': T.date,
      '착수일': T.date,
      '준공예정일': T.date,
      '준공일': T.date,
      '계약상대자': T.text,
      '사업자등록번호': T.text,
      '나라장터공고번호': T.text,
      '위탁구분': T.sel(['조달청위탁', '지자체위탁', '나라장터직접', '해당없음']),
      '설계적정성검토': T.check,
      '시스템등록일': T.date,
      '하자담보기간_개월': T.num,
      '상태': T.sel(['계약체결', '진행중', '준공', '검수완료', '해지', '정산완료']),
      '파일링크': T.url,
      '비고': T.text,
      '등록자': T.text,
      '동기화일시': T.edited,
    },
  },

  assets: {
    key: 'assets',
    title: '중요재산 DB',
    secret: 'NOTION_ASSETS_DB',
    sync: null,
    description: '보조금법 §35 중요재산. 취득 후 15일 이내 보고 의무. data/assets.json 대응.',
    properties: {
      '자산ID': T.title,
      '기관': T.sel(기관),
      '단위사업': T.sel(단위사업),
      '재산구분': T.sel(재산구분),
      '재산명': T.text,
      '규격': T.text,
      '관리번호': T.text,
      '수량': T.num,
      '취득가액': T.won,
      '취득일': T.date,
      '설치장소': T.text,
      '관리주체': T.text,
      '운영주체': T.text,
      '처분제한기간_년': T.sel(['5', '10']),
      '처분제한만료일': T.date,
      '부기등기필요': T.check,
      '취득보고일': T.date,
      '보고처': T.text,
      '증빙ID': T.text,
      '계약ID': T.text,
      '상태': T.sel(['취득', '보고완료', '운영중', '처분승인신청', '처분완료', '폐기']),
      '파일링크': T.url,
      '비고': T.text,
      '등록자': T.text,
      '동기화일시': T.edited,
    },
  },

  completion: {
    key: 'completion',
    title: '준공산출물 DB',
    secret: 'NOTION_COMPLETION_DB',
    sync: null,
    description: '단위사업별 준공서류 확보 현황. data/completion.json 대응.',
    properties: {
      '준공ID': T.title,
      '단위사업': T.sel(단위사업),
      '계약ID': T.text,
      '유형': T.sel(Object.keys(read('codes/completion-documents.json').유형별필수문서)),
      '명칭': T.text,
      '수행사': T.text,
      '확보문서': T.multi([...new Set(Object.values(read('codes/completion-documents.json').유형별필수문서).flat())]),
      '예비준공검사일': T.date,
      '준공검사일': T.date,
      '검사자': T.text,
      '검수일': T.date,
      '검수자': T.text,
      '지적사항': T.text,
      '조치완료일': T.date,
      '인계일': T.date,
      '인수기관': T.text,
      '물리적진도율': T.num,
      '상태': T.sel(['진행중', '준공검사대기', '준공완료', '인계완료', '지연']),
      '파일링크': T.url,
      '비고': T.text,
      '등록자': T.text,
      '동기화일시': T.edited,
    },
  },
};

module.exports = { DATABASES, 기관, 단위사업, 보조비목, 보조세목, 재원, 지급방식, 증빙유형, 검토상태 };
