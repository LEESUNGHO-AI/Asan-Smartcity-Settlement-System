/**
 * 아산시 강소형 스마트시티 정산시스템 — Google Form 입력 연동
 *
 * Slack 무료 플랜에는 「웹 요청 보내기」 단계가 없어, 입력 창구를 Google Form으로 대체한다.
 * 흐름:  Google Form → onFormSubmit(GAS) → Notion 정산증빙 DB → Slack 알림
 *
 * ── 설치 순서 ───────────────────────────────────────────────
 *  1) Apps Script 편집기 좌측 「파일 +」 → 스크립트 → 이름 Form 으로 생성
 *  2) 이 코드를 통째로 붙여넣고 저장
 *  3) 스크립트 속성 추가
 *       SLACK_CHANNEL_ID     C0BTB336U1M   (#정산-증빙)
 *       SLACK_ALERT_CHANNEL  C0BTQFR3V0E   (#정산-알림) ← 등록·반려 알림이 여기로
 *  4) 함수 선택 칸에서 setupForm 을 골라 ▶ 실행  ← 폼이 자동 생성됨
 *  5) 실행 로그에 나오는 「응답 URL」을 #정산-증빙 채널에 고정
 *
 *  Code.gs 의 notion(), maskDob(), normDate(), toNumber(), sel(), txt(),
 *  toList(), normBrn() 을 그대로 재사용한다. Code.gs 를 지우면 안 된다.
 */

// ══════════════════════════════════════════════════════════
// 코드 마스터 — codes/expense-categories.json 과 동일하게 유지
// ══════════════════════════════════════════════════════════
var 기관목록 = [
  'ASAN (아산시)',
  'JEIL (제일엔지니어링)',
  'HOSEO (호서대학교 산학협력단)',
  'CNI (충남연구원)',
  'KAIST (한국과학기술원)'
];

var 단위사업목록 = [
  'SP-OASIS (디지털 OASIS SPOT)',
  'SP-INNO (아산 이노베이션 스퀘어)',
  'SP-POLE (스마트폴)',
  'SP-STORE (무인매장)',
  'SP-NET (유·무선 통신망)',
  'SP-DRT (수요응답형 교통)',
  'SP-AI (AI 융합플랫폼)',
  'SP-RND (연구·리빙랩)',
  'SP-PMO (사업관리)'
];

// 비목 → 세목. 이 구조 그대로 조건부 섹션이 만들어진다.
var 비목세목 = [
  { 비목: '인건비',    세목: ['보수', '기타직보수'] },
  { 비목: '운영비',    세목: ['일반수용비', '공공요금및제세', '임차료', '복리후생비', '일반용역비'] },
  { 비목: '여비',      세목: ['국내여비', '국외여비'] },
  { 비목: '업무추진비', 세목: ['사업추진비'] },
  { 비목: '연구개발비', 세목: ['연구개발비'] },
  { 비목: '민간이전',   세목: ['민간경상보조'] },
  { 비목: '건설비',    세목: ['시설비'] },
  { 비목: '유형자산',   세목: ['자산취득비'] },
  { 비목: '무형자산',   세목: ['무형자산'] }
];

var 재원목록 = ['국비', '도비', '시비', '자기부담금'];
var 지급방식목록 = ['계좌이체', '보조금전용카드', '현금', '개인카드', '법인카드', '기타'];
var 증빙유형목록 = [
  '계약서', '견적서', '발주서', '납품서', '검수조서',
  '전자세금계산서', '세금계산서', '계좌이체증', '카드전표', '지출결의서',
  '급여대장', '근로계약서', '4대보험납부확인서', '원천징수이행상황신고서',
  '참여율확인표', '출장복명서', '기성검사조서', '준공검사조서', '사진'
];
var 인정지급방식 = ['계좌이체', '보조금전용카드'];

// 세부구분이 필요한 세목 (운영비-일반수용비 아래 회의비 분리)
var 세부구분맵 = { '일반수용비': ['일반수용비', '회의비'] };

// ══════════════════════════════════════════════════════════
// 1. 폼 생성  ← 최초 1회만 실행
//
//    Google Forms API는 짧은 시간에 항목을 많이 만들면
//    "Failed to retrieve form data" 오류를 낸다. 서버가 못 따라오는 것이므로
//    항목마다 잠깐 쉬고, 실패하면 최대 3번까지 다시 시도한다.
// ══════════════════════════════════════════════════════════

/** 실패하면 잠시 쉬었다 다시 시도한다. */
function retry_(label, fn) {
  var last;
  for (var i = 1; i <= 3; i++) {
    try {
      var r = fn();
      Utilities.sleep(600);
      return r;
    } catch (err) {
      last = err;
      console.log('  재시도 ' + i + '/3 — ' + label + ' (' + String(err).slice(0, 80) + ')');
      Utilities.sleep(3000);
    }
  }
  throw new Error(label + ' 실패: ' + last);
}

function setupForm() {
  console.log('폼 생성을 시작합니다. 1~2분 걸립니다. 창을 닫지 마십시오.');

  var form = retry_('폼 생성', function () {
    return FormApp.create('정산증빙 등록 — 아산시 강소형 스마트시티');
  });

  retry_('기본 설정', function () {
    form.setDescription(
      '보조사업 집행결과 제출 양식의 원천 데이터입니다.\n' +
      '입력된 내용은 Notion 정산증빙 DB에 등록되고, 매일 07:00에 GitHub 원장으로 동기화됩니다.\n\n' +
      '⚠ 생년월일은 일(日) 자리를 ** 로 가려서 입력하십시오. 예) \'82.05.**\n' +
      '⚠ 증빙 파일은 여기에 올리지 말고 Google Drive 링크만 넣으십시오.'
    );
    form.setProgressBar(true);
    form.setAllowResponseEdits(true);
    return true;
  });

  // ── 첫 섹션 ────────────────────────────────────────────
  console.log('[1/4] 기본 항목');
  retry_('기관', function () {
    return form.addListItem().setTitle('기관').setRequired(true).setChoiceValues(기관목록);
  });
  retry_('단위사업', function () {
    return form.addListItem().setTitle('단위사업').setRequired(true).setChoiceValues(단위사업목록);
  });
  var 비목항목 = retry_('보조비목', function () {
    return form.addMultipleChoiceItem()
      .setTitle('보조비목')
      .setHelpText('선택한 비목에 해당하는 세목만 다음 화면에 표시됩니다.')
      .setRequired(true);
  });

  // ── 비목별 섹션 ────────────────────────────────────────
  console.log('[2/4] 비목별 섹션 ' + 비목세목.length + '개');
  var 페이지 = [];
  for (var i = 0; i < 비목세목.length; i++) {
    var g = 비목세목[i];
    var page = retry_('섹션 ' + g.비목, (function (gg) {
      return function () { return form.addPageBreakItem().setTitle(gg.비목 + ' — 보조세목 선택'); };
    })(g));
    retry_('세목 ' + g.비목, (function (gg) {
      return function () {
        return form.addMultipleChoiceItem()
          .setTitle('보조세목 (' + gg.비목 + ')')
          .setRequired(true)
          .setChoiceValues(gg.세목);
      };
    })(g));
    if (g.비목 === '운영비') {
      retry_('세부구분', function () {
        return form.addMultipleChoiceItem()
          .setTitle('세부구분 (운영비)')
          .setHelpText('일반수용비를 선택한 경우에만 답하십시오. 그 외 세목은 건너뛰십시오.')
          .setRequired(false)
          .setChoiceValues(세부구분맵['일반수용비']);
      });
    }
    페이지.push(page);
  }

  // ── 공통 섹션 ──────────────────────────────────────────
  console.log('[3/4] 공통 항목');
  var 공통 = retry_('공통 섹션', function () {
    return form.addPageBreakItem().setTitle('집행 내용');
  });

  var 공통항목 = [
    ['재원', function () { return form.addMultipleChoiceItem().setTitle('재원').setRequired(true).setChoiceValues(재원목록); }],
    ['지급처구분', function () { return form.addMultipleChoiceItem().setTitle('지급처구분').setRequired(true).setHelpText('법인·개인사업자는 「사업자」, 개인(급여·여비·평가위원 수당)은 「개인」').setChoiceValues(['사업자', '개인']); }],
    ['지급처명', function () { return form.addTextItem().setTitle('지급처명').setRequired(true).setHelpText('사업자는 상호, 개인은 성명'); }],
    ['사업자등록번호', function () { return form.addTextItem().setTitle('사업자등록번호').setRequired(false).setHelpText('사업자인 경우만. 000-00-00000'); }],
    ['생년월일', function () { return form.addTextItem().setTitle('생년월일').setRequired(false).setHelpText("개인인 경우만. 일(日) 자리는 반드시 ** 로 가려주십시오. 예) '82.05.**"); }],
    ['참여율', function () { return form.addTextItem().setTitle('참여율').setRequired(false).setHelpText('인건비·여비인 경우만. 숫자만 입력 (예: 90)'); }],
    ['귀속월', function () { return form.addTextItem().setTitle('귀속월').setRequired(false).setHelpText('인건비인 경우만. 예: 2026-07'); }],
    ['집행일자', function () { return form.addDateItem().setTitle('집행일자').setRequired(true); }],
    ['집행금액', function () { return form.addTextItem().setTitle('집행금액').setRequired(true).setHelpText('원 단위 숫자만. 예: 1000000'); }],
    ['사용목적', function () { return form.addParagraphTextItem().setTitle('사용목적').setRequired(true).setHelpText('사업 관련성이 드러나게 구체적으로. 「회의」처럼 짧으면 반려됩니다.'); }],
    ['지급방식', function () { return form.addMultipleChoiceItem().setTitle('지급방식').setRequired(true).setHelpText('계좌이체·보조금전용카드만 보조금으로 인정됩니다(통합관리지침 §18①)').setChoiceValues(지급방식목록); }],
    ['증빙유형', function () { return form.addCheckboxItem().setTitle('증빙유형').setRequired(true).setHelpText('확보한 증빙을 모두 선택하십시오').setChoiceValues(증빙유형목록); }],
    ['계약ID', function () { return form.addTextItem().setTitle('계약ID').setRequired(false).setHelpText('계약 기반 지출인 경우. 예: CT-2026-0001'); }],
    ['파일링크', function () { return form.addTextItem().setTitle('파일링크').setRequired(false).setHelpText('Google Drive 공유 링크'); }],
    ['선금여부', function () { return form.addCheckboxItem().setTitle('선금여부').setRequired(false).setChoiceValues(['선금입니다']); }],
    ['등록자', function () { return form.addTextItem().setTitle('등록자').setRequired(true).setHelpText('본인 성명'); }]
  ];
  for (var c = 0; c < 공통항목.length; c++) {
    retry_(공통항목[c][0], 공통항목[c][1]);
  }

  // ── 분기 연결 ──────────────────────────────────────────
  console.log('[4/4] 분기 연결');
  Utilities.sleep(2000);
  retry_('비목 분기', function () {
    var 선택지 = [];
    for (var j = 0; j < 비목세목.length; j++) {
      선택지.push(비목항목.createChoice(비목세목[j].비목, 페이지[j]));
    }
    비목항목.setChoices(선택지);
    return true;
  });
  for (var k = 0; k < 페이지.length; k++) {
    retry_('섹션 연결 ' + (k + 1), (function (pg) {
      return function () { return pg.setGoToPage(공통); };
    })(페이지[k]));
  }

  // ── 제출 트리거 ────────────────────────────────────────
  var triggers = ScriptApp.getProjectTriggers();
  for (var t = 0; t < triggers.length; t++) {
    if (triggers[t].getHandlerFunction() === 'onFormSubmit') ScriptApp.deleteTrigger(triggers[t]);
  }
  ScriptApp.newTrigger('onFormSubmit').forForm(form).onFormSubmit().create();

  PropertiesService.getScriptProperties().setProperty('FORM_ID', form.getId());

  console.log('');
  console.log('════════════════════════════════════════════');
  console.log(' 폼 생성 완료');
  console.log('════════════════════════════════════════════');
  console.log(' 응답 URL (이걸 Slack에 고정하십시오)');
  console.log(' ' + form.getPublishedUrl());
  console.log('');
  console.log(' 편집 URL (질문 수정이 필요할 때)');
  console.log(' ' + form.getEditUrl());
  console.log('');
  console.log(' 항목 ' + form.getItems().length + '개 · 비목별 조건부 섹션 ' + 페이지.length + '개');
}

// ══════════════════════════════════════════════════════════
// 1-B. 단순 폼 생성  ← setupForm 이 계속 실패할 때만 사용
//
//    조건부 섹션 없이 한 장짜리 폼을 만든다. 항목 수가 절반이라 훨씬 안정적이다.
//    보조세목이 13개 전부 보이는 점만 다르고, 비목·세목 짝 검사는
//    validateForm() 이 그대로 하므로 잘못된 조합은 여전히 반려된다.
// ══════════════════════════════════════════════════════════
function setupFormSimple() {
  console.log('단순 폼 생성을 시작합니다.');

  var 전체세목 = [];
  for (var i = 0; i < 비목세목.length; i++) {
    for (var j = 0; j < 비목세목[i].세목.length; j++) {
      if (전체세목.indexOf(비목세목[i].세목[j]) < 0) 전체세목.push(비목세목[i].세목[j]);
    }
  }

  var form = retry_('폼 생성', function () {
    return FormApp.create('정산증빙 등록(단순) — 아산시 강소형 스마트시티');
  });
  retry_('설명', function () {
    form.setDescription('⚠ 생년월일은 일(日) 자리를 ** 로 가려서 입력하십시오. 예) \'82.05.**');
    return true;
  });

  var 항목 = [
    ['기관', function () { return form.addListItem().setTitle('기관').setRequired(true).setChoiceValues(기관목록); }],
    ['단위사업', function () { return form.addListItem().setTitle('단위사업').setRequired(true).setChoiceValues(단위사업목록); }],
    ['보조비목', function () { return form.addListItem().setTitle('보조비목').setRequired(true).setChoiceValues(비목세목.map(function (g) { return g.비목; })); }],
    ['보조세목', function () { return form.addListItem().setTitle('보조세목').setRequired(true).setHelpText('선택한 보조비목에 속하는 세목을 고르십시오. 짝이 맞지 않으면 반려됩니다.').setChoiceValues(전체세목); }],
    ['세부구분', function () { return form.addListItem().setTitle('세부구분').setRequired(false).setHelpText('운영비-일반수용비인 경우만').setChoiceValues(세부구분맵['일반수용비']); }],
    ['재원', function () { return form.addListItem().setTitle('재원').setRequired(true).setChoiceValues(재원목록); }],
    ['지급처구분', function () { return form.addListItem().setTitle('지급처구분').setRequired(true).setChoiceValues(['사업자', '개인']); }],
    ['지급처명', function () { return form.addTextItem().setTitle('지급처명').setRequired(true); }],
    ['사업자등록번호', function () { return form.addTextItem().setTitle('사업자등록번호').setRequired(false); }],
    ['생년월일', function () { return form.addTextItem().setTitle('생년월일').setRequired(false).setHelpText("'82.05.** 형식"); }],
    ['참여율', function () { return form.addTextItem().setTitle('참여율').setRequired(false); }],
    ['귀속월', function () { return form.addTextItem().setTitle('귀속월').setRequired(false).setHelpText('예: 2026-07'); }],
    ['집행일자', function () { return form.addDateItem().setTitle('집행일자').setRequired(true); }],
    ['집행금액', function () { return form.addTextItem().setTitle('집행금액').setRequired(true); }],
    ['사용목적', function () { return form.addParagraphTextItem().setTitle('사용목적').setRequired(true); }],
    ['지급방식', function () { return form.addListItem().setTitle('지급방식').setRequired(true).setChoiceValues(지급방식목록); }],
    ['증빙유형', function () { return form.addCheckboxItem().setTitle('증빙유형').setRequired(true).setChoiceValues(증빙유형목록); }],
    ['계약ID', function () { return form.addTextItem().setTitle('계약ID').setRequired(false); }],
    ['파일링크', function () { return form.addTextItem().setTitle('파일링크').setRequired(false); }],
    ['등록자', function () { return form.addTextItem().setTitle('등록자').setRequired(true); }]
  ];
  for (var k = 0; k < 항목.length; k++) {
    console.log('  ' + (k + 1) + '/' + 항목.length + ' ' + 항목[k][0]);
    retry_(항목[k][0], 항목[k][1]);
  }

  var triggers = ScriptApp.getProjectTriggers();
  for (var t = 0; t < triggers.length; t++) {
    if (triggers[t].getHandlerFunction() === 'onFormSubmit') ScriptApp.deleteTrigger(triggers[t]);
  }
  ScriptApp.newTrigger('onFormSubmit').forForm(form).onFormSubmit().create();
  PropertiesService.getScriptProperties().setProperty('FORM_ID', form.getId());

  console.log('');
  console.log('════════════════════════════════════════════');
  console.log(' 단순 폼 생성 완료');
  console.log('════════════════════════════════════════════');
  console.log(' 응답 URL: ' + form.getPublishedUrl());
  console.log(' 편집 URL: ' + form.getEditUrl());
}

// ══════════════════════════════════════════════════════════
// 2. 폼 제출 → Notion 등록
// ══════════════════════════════════════════════════════════
function onFormSubmit(e) {
  try {
    var v = e.namedValues;
    var f = {};

    // 단일값 추출 ('ASAN (아산시)' → 'ASAN')
    function one(key) {
      var a = v[key];
      return a && a[0] ? String(a[0]).trim() : '';
    }
    function code(key) {
      var s = one(key);
      var m = s.match(/^(\S+)\s*\(/);
      return m ? m[1] : s;
    }

    f.기관 = code('기관');
    f.단위사업 = code('단위사업');
    f.보조비목 = one('보조비목');

    // 보조세목은 비목별로 다른 항목명에 들어온다. 값이 있는 것을 찾는다.
    for (var key in v) {
      if (key.indexOf('보조세목') === 0 && v[key][0]) { f.보조세목 = String(v[key][0]).trim(); break; }
      if (key.indexOf('세부구분') === 0 && v[key][0]) { f.세부구분 = String(v[key][0]).trim(); }
    }
    for (var key2 in v) {
      if (key2.indexOf('세부구분') === 0 && v[key2][0]) f.세부구분 = String(v[key2][0]).trim();
    }

    f.재원 = one('재원');
    f.지급처구분 = one('지급처구분');
    f.지급처명 = one('지급처명');
    f.사업자등록번호 = one('사업자등록번호');
    f.생년월일 = one('생년월일');
    f.참여율 = one('참여율');
    f.귀속월 = one('귀속월');
    f.집행일자 = one('집행일자');
    f.집행금액 = one('집행금액');
    f.사용목적 = one('사용목적');
    f.지급방식 = one('지급방식');
    f.증빙유형 = one('증빙유형');   // 체크박스는 쉼표로 이어진 문자열
    f.계약ID = one('계약ID');
    f.파일링크 = one('파일링크');
    f.선금여부 = one('선금여부') ? true : false;
    f.등록자 = one('등록자');

    var 오류 = validateForm(f);
    if (오류.length) {
      notifySlack('❌ *정산증빙 등록 실패* — ' + (f.등록자 || '?') + '\n• ' + 오류.join('\n• ') +
        '\n\n_폼에서 다시 제출해 주십시오._');
      console.error(오류.join(' / '));
      return;
    }

    var page = createNotionEvidence(f);

    notifySlack(
      '✅ *정산증빙 등록 완료* — ' + f.등록자 + '\n' +
      '• ' + f.보조비목 + '(' + f.보조세목 + ') / ' + f.재원 + '\n' +
      '• ' + f.지급처명 + ' / ' + Number(toNumber(f.집행금액)).toLocaleString('ko-KR') + '원\n' +
      '• ' + f.집행일자 + ' / ' + f.지급방식 + '\n' +
      '• 증빙ID는 익일 07:00 동기화 시 자동 부여됩니다.' +
      (page.url ? '\n• <' + page.url + '|Notion에서 보기>' : '')
    );
  } catch (err) {
    console.error(err);
    notifySlack('🚨 *정산증빙 등록 중 오류*\n```' + String(err).slice(0, 500) + '```');
  }
}

// ══════════════════════════════════════════════════════════
// 3. 검증 — 잘못된 데이터가 Notion에 들어가기 전에 막는다
// ══════════════════════════════════════════════════════════
function validateForm(f) {
  var e = [];

  // 비목·세목 짝 검사
  var 짝 = null;
  for (var i = 0; i < 비목세목.length; i++) if (비목세목[i].비목 === f.보조비목) 짝 = 비목세목[i];
  if (!짝) e.push('보조비목 값 오류: ' + f.보조비목);
  else if (짝.세목.indexOf(f.보조세목) < 0) {
    e.push('보조세목 오류: ' + f.보조비목 + ' 하위에 ' + f.보조세목 + ' 없음');
  }

  if (재원목록.indexOf(f.재원) < 0) e.push('재원 값 오류: ' + f.재원);
  if (지급방식목록.indexOf(f.지급방식) < 0) e.push('지급방식 값 오류: ' + f.지급방식);

  // 통합관리지침 §18① — 인정되지 않는 지급방식
  if (인정지급방식.indexOf(f.지급방식) < 0) {
    e.push('⚠ ' + f.지급방식 + '은(는) 보조금 인정 지급방식이 아닙니다(지침 §18①). 정산 불인정 위험');
  }

  if (!normDate(f.집행일자)) e.push('집행일자 형식 오류: ' + f.집행일자);
  if (!toNumber(f.집행금액)) e.push('집행금액 오류: ' + f.집행금액);
  if (!f.지급처명) e.push('지급처명 누락');
  if (!f.사용목적 || f.사용목적.trim().length < 5) {
    e.push('사용목적이 너무 짧습니다 — 사업 관련성이 드러나게 기재하십시오');
  }
  if (!toList(f.증빙유형).length) e.push('증빙유형 최소 1개 필요');

  // 인건비는 개인 + 참여율이 있어야 한다
  if (f.보조비목 === '인건비') {
    if (f.지급처구분 !== '개인') e.push('인건비는 지급처구분을 「개인」으로 선택해야 합니다');
    if (!f.참여율) e.push('인건비는 참여율이 필요합니다');
    if (!f.귀속월) e.push('인건비는 귀속월이 필요합니다 (예: 2026-07)');
  }
  if (f.참여율 && (toNumber(f.참여율) < 0 || toNumber(f.참여율) > 100)) {
    e.push('참여율은 0~100 사이여야 합니다: ' + f.참여율);
  }

  // 개인정보 — 마스킹되지 않은 생년월일은 받지 않는다
  if (f.지급처구분 === '개인' && f.생년월일 && !maskDob(f.생년월일)) {
    e.push("생년월일 형식 오류. '82.05.** 형식으로 입력하십시오");
  }
  return e;
}

// ══════════════════════════════════════════════════════════
// 4. Notion 페이지 생성
// ══════════════════════════════════════════════════════════
function createNotionEvidence(f) {
  var 구분 = f.지급처구분 || '사업자';

  var props = {
    '증빙ID': { title: [] },                      // 동기화 시 자동 채번
    '기관': sel(f.기관),
    '단위사업': sel(f.단위사업),
    '보조비목': sel(f.보조비목),
    '보조세목': sel(f.보조세목),
    '재원': sel(f.재원),
    '지급처구분': sel(구분),
    '지급처명': txt(f.지급처명),
    '집행일자': { date: { start: normDate(f.집행일자) } },
    '집행금액': { number: toNumber(f.집행금액) },
    '사용목적': txt(f.사용목적),
    '지급방식': sel(f.지급방식),
    '증빙유형': { multi_select: toList(f.증빙유형).map(function (x) { return { name: x }; }) },
    '검토상태': sel('제출완료'),
    '등록자': txt(f.등록자 || 'Google Form')
  };

  if (f.세부구분) props['세부구분'] = sel(f.세부구분);
  if (f.계약ID) props['계약ID'] = txt(f.계약ID);
  if (f.귀속월) props['귀속월'] = txt(f.귀속월);
  if (f.파일링크) props['파일링크'] = { url: f.파일링크 };
  if (f.선금여부) props['선금여부'] = { checkbox: true };

  if (구분 === '사업자') {
    if (f.사업자등록번호) props['사업자등록번호'] = txt(normBrn(f.사업자등록번호));
  } else {
    // 개인정보 1차 방어선 — Notion에 원본이 들어가지 않게 여기서 마스킹한다
    var dob = maskDob(f.생년월일);
    if (dob) props['생년월일'] = txt(dob);
    if (f.참여율 !== '') props['참여율'] = { number: toNumber(f.참여율) };
  }

  return notion('POST', 'pages', {
    parent: { database_id: PropertiesService.getScriptProperties().getProperty('NOTION_EVIDENCE_DB') },
    properties: props
  });
}

// ══════════════════════════════════════════════════════════
// 5. Slack 알림
// ══════════════════════════════════════════════════════════
function notifySlack(text) {
  var P = PropertiesService.getScriptProperties();
  var token = P.getProperty('SLACK_BOT_TOKEN');
  // 알림은 #정산-알림 으로. 속성이 없으면 #정산-증빙 으로 떨어진다.
  var channel = P.getProperty('SLACK_ALERT_CHANNEL') || P.getProperty('SLACK_CHANNEL_ID');
  if (!token || !channel) { console.log('[Slack 미설정] ' + text); return; }

  UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', {
    method: 'post',
    contentType: 'application/json; charset=utf-8',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ channel: channel, text: text }),
    muteHttpExceptions: true
  });
}

// ══════════════════════════════════════════════════════════
// 6. 점검용
// ══════════════════════════════════════════════════════════
function showFormUrl() {
  var id = PropertiesService.getScriptProperties().getProperty('FORM_ID');
  if (!id) { console.log('아직 폼이 없습니다. setupForm() 을 먼저 실행하십시오.'); return; }
  var form = FormApp.openById(id);
  console.log('응답 URL: ' + form.getPublishedUrl());
  console.log('편집 URL: ' + form.getEditUrl());
  console.log('응답 수: ' + form.getResponses().length + '건');
}

/** 폼 없이 등록 경로만 시험한다. 성공하면 Notion에 테스트 레코드가 1건 생긴다. */
function testFormSubmit() {
  onFormSubmit({
    namedValues: {
      '기관': ['JEIL (제일엔지니어링)'],
      '단위사업': ['SP-NET (유·무선 통신망)'],
      '보조비목': ['건설비'],
      '보조세목 (건설비)': ['시설비'],
      '재원': ['국비'],
      '지급처구분': ['사업자'],
      '지급처명': ['주식회사 싸인텔레콤'],
      '사업자등록번호': ['114-81-82595'],
      '집행일자': ['2026-08-31'],
      '집행금액': ['1000000'],
      '사용목적': ['유무선 네트워크 구축 용역 연결 테스트'],
      '지급방식': ['계좌이체'],
      '증빙유형': ['전자세금계산서, 계좌이체증'],
      '등록자': ['테스트']
    }
  });
}
