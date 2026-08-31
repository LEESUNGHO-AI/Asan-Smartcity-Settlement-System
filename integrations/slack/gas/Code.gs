/**
 * 아산시 강소형 스마트시티 정산시스템 — Slack → Notion 연계
 *
 * 배포: Apps Script → 배포 → 새 배포 → 웹 앱
 *       실행 계정: 나 / 액세스: 모든 사용자
 *       생성된 URL을 Slack Workflow의 "웹 요청 보내기" 단계에 등록
 *
 * 스크립트 속성(파일 → 프로젝트 설정 → 스크립트 속성):
 *   NOTION_TOKEN         내부 통합 토큰
 *   NOTION_EVIDENCE_DB   정산증빙 DB ID
 *   SLACK_BOT_TOKEN      스레드 회신용 (xoxb-...)
 *   SLACK_SIGNING_SECRET Slack 요청 서명 검증용
 */

var PROP = PropertiesService.getScriptProperties();
var NOTION_VER = '2022-06-28';

// 코드 마스터 — codes/expense-categories.json 과 동일하게 유지할 것
var 세목맵 = {
  '인건비': ['보수', '기타직보수'],
  '운영비': ['일반수용비', '공공요금및제세', '임차료', '복리후생비', '일반용역비'],
  '여비': ['국내여비', '국외여비'],
  '업무추진비': ['사업추진비'],
  '연구개발비': ['연구개발비'],
  '민간이전': ['민간경상보조'],
  '건설비': ['시설비'],
  '유형자산': ['자산취득비'],
  '무형자산': ['무형자산']
};
var 기관목록 = ['ASAN', 'JEIL', 'HOSEO', 'CNI', 'KAIST'];
var 재원목록 = ['국비', '도비', '시비', '자기부담금'];
var 지급방식목록 = ['계좌이체', '보조금전용카드', '현금', '개인카드', '법인카드', '기타'];

// ══════════════════════════════════════════════════════════
// 진입점
// ══════════════════════════════════════════════════════════
function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);

    // Slack Events API URL 검증
    if (body.type === 'url_verification') {
      return ContentService.createTextOutput(body.challenge);
    }

    var payload = body.payload ? JSON.parse(body.payload) : body;
    var result = handleEvidence(payload);
    return json({ ok: true, 증빙: result.title, url: result.url });
  } catch (err) {
    logError(err, e && e.postData && e.postData.contents);
    return json({ ok: false, error: String(err) });
  }
}

// ══════════════════════════════════════════════════════════
// 증빙 등록
// ══════════════════════════════════════════════════════════
function handleEvidence(f) {
  var err = validate(f);
  if (err.length) {
    replyToSlack(f, '❌ 등록 실패\n• ' + err.join('\n• '));
    throw new Error(err.join(' / '));
  }

  var 구분 = f.지급처구분 || (f.생년월일 ? '개인' : '사업자');
  var props = {
    '증빙ID': { title: [] },                       // 동기화 시 자동 채번
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
    '증빙유형': { multi_select: toList(f.증빙유형).map(function (v) { return { name: v }; }) },
    '검토상태': sel('제출완료'),
    '등록자': txt(f.user_name || f.등록자 || 'Slack')
  };

  if (f.세부구분) props['세부구분'] = sel(f.세부구분);
  if (f.계약ID) props['계약ID'] = txt(f.계약ID);
  if (f.자산ID) props['자산ID'] = txt(f.자산ID);
  if (f.귀속월) props['귀속월'] = txt(f.귀속월);
  if (f.공급가액) props['공급가액'] = { number: toNumber(f.공급가액) };
  if (f.부가세) props['부가세'] = { number: toNumber(f.부가세) };
  if (f.파일링크) props['파일링크'] = { url: f.파일링크 };
  if (f.선금여부) props['선금여부'] = { checkbox: truthy(f.선금여부) };

  if (구분 === '사업자') {
    if (f.사업자등록번호) props['사업자등록번호'] = txt(normBrn(f.사업자등록번호));
  } else {
    // 개인정보 방어선 1차 — 생년월일 일(日) 자리를 여기서 마스킹한다.
    // Notion에 원본이 들어가지 않도록 GAS 단계에서 차단하는 것이 핵심이다.
    var dob = maskDob(f.생년월일);
    if (dob) props['생년월일'] = txt(dob);
    if (f.참여율 !== undefined && f.참여율 !== '') {
      props['참여율'] = { number: toNumber(f.참여율) };
    }
  }

  var slackUrl = slackPermalink(f);
  if (slackUrl) props['Slack링크'] = { url: slackUrl };

  var page = notion('POST', 'pages', {
    parent: { database_id: PROP.getProperty('NOTION_EVIDENCE_DB') },
    properties: props
  });

  replyToSlack(f,
    '✅ 정산증빙 등록 완료\n' +
    '• ' + f.보조비목 + '(' + f.보조세목 + ') / ' + f.재원 + '\n' +
    '• ' + f.지급처명 + ' / ' + Number(toNumber(f.집행금액)).toLocaleString('ko-KR') + '원\n' +
    '• 증빙ID는 익일 07:00 동기화 시 자동 부여됩니다.\n' +
    (page.url ? '• Notion: ' + page.url : ''));

  return { title: f.지급처명, url: page.url };
}

// ══════════════════════════════════════════════════════════
// 1차 검증 — 형식 오류를 Notion 앞단에서 잡는다
// ══════════════════════════════════════════════════════════
function validate(f) {
  var e = [];
  if (기관목록.indexOf(f.기관) < 0) e.push('기관 값 오류: ' + f.기관);
  if (!세목맵[f.보조비목]) e.push('보조비목 값 오류: ' + f.보조비목);
  else if (세목맵[f.보조비목].indexOf(f.보조세목) < 0) {
    e.push('보조세목 오류: ' + f.보조비목 + ' 하위에 ' + f.보조세목 + ' 없음');
  }
  if (재원목록.indexOf(f.재원) < 0) e.push('재원 값 오류: ' + f.재원);
  if (지급방식목록.indexOf(f.지급방식) < 0) e.push('지급방식 값 오류: ' + f.지급방식);

  // 통합관리지침 §18① — 인정되지 않는 지급방식은 등록 시점에 경고한다
  if (['계좌이체', '보조금전용카드'].indexOf(f.지급방식) < 0) {
    e.push('⚠ ' + f.지급방식 + '은(는) 보조금 인정 지급방식이 아닙니다(지침 §18①). 정산 불인정 위험');
  }
  if (!normDate(f.집행일자)) e.push('집행일자 형식 오류(YYYY-MM-DD): ' + f.집행일자);
  if (!toNumber(f.집행금액)) e.push('집행금액 오류: ' + f.집행금액);
  if (!f.지급처명) e.push('지급처명 누락');
  if (!f.사용목적 || String(f.사용목적).trim().length < 5) {
    e.push('사용목적이 너무 짧습니다 — 사업 관련성이 드러나게 기재하십시오');
  }
  if (!toList(f.증빙유형).length) e.push('증빙유형 최소 1개 필요');
  return e;
}

// ══════════════════════════════════════════════════════════
// 유틸
// ══════════════════════════════════════════════════════════
function sel(v) { return { select: { name: String(v) } }; }
function txt(v) { return { rich_text: [{ text: { content: String(v == null ? '' : v).slice(0, 1900) } }] }; }
function truthy(v) { return v === true || v === 'true' || v === 'Y' || v === '예' || v === 1; }
function toNumber(v) {
  if (v == null) return 0;
  var n = Number(String(v).replace(/[^0-9.-]/g, ''));
  return isNaN(n) ? 0 : Math.round(n);
}
function toList(v) {
  if (!v) return [];
  if (Object.prototype.toString.call(v) === '[object Array]') return v;
  return String(v).split(/[,;·\n]/).map(function (s) { return s.trim(); }).filter(Boolean);
}
function normDate(v) {
  if (!v) return null;
  var s = String(v).trim().replace(/[.\/]/g, '-').replace(/-$/, '');
  var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) return null;
  return m[1] + '-' + pad(m[2]) + '-' + pad(m[3]);
}
function pad(n) { return String(n).length < 2 ? '0' + n : String(n); }
function normBrn(v) {
  var d = String(v).replace(/[^0-9]/g, '');
  return d.length === 10 ? d.slice(0, 3) + '-' + d.slice(3, 5) + '-' + d.slice(5) : String(v);
}
/** 생년월일 일(日) 자리 마스킹. '82.05.10 → '82.05.** */
function maskDob(v) {
  if (!v) return null;
  var s = String(v).trim().replace(/^'/, '').replace(/[.\/-]/g, '.');
  var m = s.match(/^(\d{2,4})\.(\d{1,2})\.(\d{1,2}|\*\*)$/);
  if (!m) return null;
  var yy = m[1].length === 4 ? m[1].slice(2) : pad(m[1]);
  return "'" + yy + '.' + pad(m[2]) + '.**';
}

function json(o) {
  return ContentService.createTextOutput(JSON.stringify(o))
    .setMimeType(ContentService.MimeType.JSON);
}

function notion(method, endpoint, body) {
  var res = UrlFetchApp.fetch('https://api.notion.com/v1/' + endpoint, {
    method: method,
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + PROP.getProperty('NOTION_TOKEN'),
      'Notion-Version': NOTION_VER
    },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code >= 300) throw new Error('Notion ' + code + ': ' + res.getContentText().slice(0, 300));
  return JSON.parse(res.getContentText());
}

function replyToSlack(f, text) {
  var token = PROP.getProperty('SLACK_BOT_TOKEN');
  if (!token || !f.channel_id) return;
  UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({
      channel: f.channel_id,
      thread_ts: f.thread_ts || f.message_ts,
      text: text
    }),
    muteHttpExceptions: true
  });
}

function slackPermalink(f) {
  if (!f.team_domain || !f.channel_id || !f.message_ts) return null;
  return 'https://' + f.team_domain + '.slack.com/archives/' + f.channel_id +
    '/p' + String(f.message_ts).replace('.', '');
}

function logError(err, raw) {
  var sheet = PROP.getProperty('ERROR_LOG_SHEET');
  console.error(String(err), raw);
  if (!sheet) return;
  try {
    SpreadsheetApp.openById(sheet).getSheets()[0]
      .appendRow([new Date(), String(err), String(raw).slice(0, 5000)]);
  } catch (e) { /* 로깅 실패는 무시 */ }
}

// ══════════════════════════════════════════════════════════
// 설치 확인용
// ══════════════════════════════════════════════════════════
function testConnection() {
  var db = notion('GET', 'databases/' + PROP.getProperty('NOTION_EVIDENCE_DB'));
  var names = Object.keys(db.properties);
  var 필수 = ['증빙ID', '기관', '단위사업', '보조비목', '보조세목', '재원',
    '지급처구분', '지급처명', '집행일자', '집행금액', '사용목적', '지급방식', '증빙유형', '검토상태'];
  var 누락 = 필수.filter(function (n) { return names.indexOf(n) < 0; });
  console.log('DB: ' + (db.title[0] ? db.title[0].plain_text : '(제목없음)'));
  console.log('속성 ' + names.length + '개');
  console.log(누락.length ? '❌ 누락 속성: ' + 누락.join(', ') : '✅ 필수 속성 모두 존재');
}
