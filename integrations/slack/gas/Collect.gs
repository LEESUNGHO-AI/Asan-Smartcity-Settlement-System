/**
 * 아산시 강소형 스마트시티 정산시스템 — Slack 사업비 엑셀 자동 수집
 *
 *   Slack #플랜예산 (최신 xlsx)  →  GitHub source/{기관}/사업비.xlsx  →  워크플로 자동 실행
 *
 * 매일 한 번 돌면서 채널에 올라온 가장 최근 엑셀을 GitHub에 커밋한다.
 * 파일이 바뀌지 않았으면 아무것도 하지 않는다(같은 커밋을 반복하지 않기 위함).
 *
 * ── 설치 ────────────────────────────────────────────────
 *  1) Apps Script 편집기 → 파일 + → 스크립트 → 이름 Collect
 *  2) 이 코드를 붙여넣고 저장
 *  3) 스크립트 속성 추가
 *       GITHUB_TOKEN   GitHub Personal access token (Contents: Read and write)
 *       GITHUB_REPO    LEESUNGHO-AI/Asan-Smartcity-Settlement-System
 *  4) Slack 앱에 권한 추가 후 재설치
 *       files:read  (파일 목록·다운로드)
 *  5) setupCollectTrigger() 실행  → 매일 06:30 KST 자동 수집 시작
 *  6) collectNow() 로 즉시 한 번 시험
 */

var CP = PropertiesService.getScriptProperties();

/** 채널 → 기관 코드. 기관별 채널이 생기면 여기에 추가한다. */
var 수집대상 = [
  { channel: 'C0836U9HVU1', 기관: 'JEIL',  설명: '#플랜예산' }
  // { channel: 'C........', 기관: 'HOSEO', 설명: '#호서대-정산' },
  // { channel: 'C........', 기관: 'CNI',   설명: '#충남연구원-정산' },
  // { channel: 'C........', 기관: 'KAIST', 설명: '#KAIST-정산' }
];

// ══════════════════════════════════════════════════════════
// 실행 진입점
// ══════════════════════════════════════════════════════════
function collectNow() { collectAll(true); }
function collectDaily() { collectAll(false); }

function collectAll(수동) {
  var 결과 = [];
  for (var i = 0; i < 수집대상.length; i++) {
    var t = 수집대상[i];
    try {
      결과.push(collectOne(t, 수동));
    } catch (err) {
      console.error(t.기관 + ': ' + err);
      결과.push({ 기관: t.기관, 상태: '실패', 메시지: String(err).slice(0, 200) });
    }
  }
  reportCollect(결과, 수동);
  return 결과;
}

function collectOne(t, 수동) {
  var file = latestSpreadsheet(t.channel);
  if (!file) return { 기관: t.기관, 상태: '없음', 메시지: t.설명 + ' 에 엑셀 파일이 없습니다' };

  var 최근키 = 'LAST_FILE_' + t.기관;
  if (!수동 && CP.getProperty(최근키) === file.id) {
    return { 기관: t.기관, 상태: '변경없음', 메시지: file.name + ' (이미 반영됨)' };
  }

  var blob = downloadSlackFile(file);
  var 경로 = 'source/' + t.기관 + '/사업비.xlsx';
  var 결과 = commitToGitHub(경로, blob, file, t.기관);

  CP.setProperty(최근키, file.id);
  return {
    기관: t.기관, 상태: 결과.변경 ? '반영' : '동일',
    메시지: file.name + ' (' + Math.round(file.size / 1024) + 'KB, ' + file.올린이 + ' ' + file.일시 + ')',
    커밋: 결과.url
  };
}

// ══════════════════════════════════════════════════════════
// Slack — 채널에서 가장 최근 엑셀 찾기
// ══════════════════════════════════════════════════════════
function latestSpreadsheet(channel) {
  var res = slack('files.list', { channel: channel, types: 'spreadsheets', count: 50 });
  var files = (res.files || []).filter(function (f) {
    return /\.xlsx?$/i.test(f.name || '') && !/^~\$/.test(f.name);
  });
  if (!files.length) return null;
  files.sort(function (a, b) { return b.created - a.created; });
  var f = files[0];
  return {
    id: f.id, name: f.name, size: f.size,
    url: f.url_private_download || f.url_private,
    올린이: (f.user_team ? '' : '') + (f.username || f.user || ''),
    일시: Utilities.formatDate(new Date(f.created * 1000), 'Asia/Seoul', 'yyyy-MM-dd')
  };
}

function downloadSlackFile(file) {
  var res = UrlFetchApp.fetch(file.url, {
    headers: { Authorization: 'Bearer ' + CP.getProperty('SLACK_BOT_TOKEN') },
    muteHttpExceptions: true, followRedirects: true
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('Slack 파일 다운로드 실패 ' + res.getResponseCode() + ' — 앱 권한에 files:read 가 있는지 확인하십시오');
  }
  var blob = res.getBlob();
  if (blob.getBytes().length < 5000) throw new Error('파일이 너무 작습니다. 권한 오류로 HTML 을 받았을 수 있습니다.');
  return blob;
}

function slack(method, params) {
  var url = 'https://slack.com/api/' + method + '?' + Object.keys(params).map(function (k) {
    return k + '=' + encodeURIComponent(params[k]);
  }).join('&');
  var res = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + CP.getProperty('SLACK_BOT_TOKEN') },
    muteHttpExceptions: true
  });
  var j = JSON.parse(res.getContentText());
  if (!j.ok) throw new Error('Slack ' + method + ': ' + j.error +
    (j.error === 'missing_scope' ? ' — 앱에 files:read 권한을 추가하고 재설치하십시오' : ''));
  return j;
}

// ══════════════════════════════════════════════════════════
// GitHub — 같은 내용이면 커밋하지 않는다
// ══════════════════════════════════════════════════════════
function commitToGitHub(경로, blob, file, 기관) {
  var repo = CP.getProperty('GITHUB_REPO');
  var tok = CP.getProperty('GITHUB_TOKEN');
  if (!repo || !tok) throw new Error('스크립트 속성 GITHUB_REPO, GITHUB_TOKEN 을 설정하십시오');

  var api = 'https://api.github.com/repos/' + repo + '/contents/' + 경로;
  var hd = { Authorization: 'Bearer ' + tok, Accept: 'application/vnd.github+json' };
  var b64 = Utilities.base64Encode(blob.getBytes());

  var sha = null;
  var cur = UrlFetchApp.fetch(api, { headers: hd, muteHttpExceptions: true });
  if (cur.getResponseCode() === 200) {
    var j = JSON.parse(cur.getContentText());
    sha = j.sha;
    // 내용이 같으면 커밋하지 않는다 (같은 커밋 반복 방지)
    if (String(j.content || '').replace(/\s/g, '') === b64) return { 변경: false, url: j.html_url };
  }

  var body = {
    message: 'data(' + 기관 + '): Slack 자동 수집 — ' + file.name + ' (' + file.일시 + ')',
    content: b64
  };
  if (sha) body.sha = sha;

  var put = UrlFetchApp.fetch(api, {
    method: 'put', contentType: 'application/json',
    headers: hd, payload: JSON.stringify(body), muteHttpExceptions: true
  });
  if (put.getResponseCode() >= 300) {
    throw new Error('GitHub ' + put.getResponseCode() + ': ' + put.getContentText().slice(0, 200));
  }
  return { 변경: true, url: JSON.parse(put.getContentText()).content.html_url };
}

// ══════════════════════════════════════════════════════════
// 알림
// ══════════════════════════════════════════════════════════
function reportCollect(결과, 수동) {
  var 반영 = 결과.filter(function (r) { return r.상태 === '반영'; });
  if (!수동 && !반영.length) { console.log('변경 없음 — 알림 생략'); return; }

  var 줄 = 결과.map(function (r) {
    var 표 = { '반영': ':white_check_mark:', '변경없음': ':heavy_minus_sign:', '동일': ':heavy_minus_sign:',
               '없음': ':warning:', '실패': ':x:' }[r.상태] || '';
    return 표 + ' *' + r.기관 + '* ' + r.상태 + ' — ' + r.메시지;
  }).join('\n');

  var text = '*사업비 엑셀 자동 수집* (' +
    Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm') + ' KST)\n' + 줄 +
    (반영.length ? '\n\n반영된 파일은 GitHub Actions 가 이어서 파싱·검증·양식생성을 수행합니다.' : '');

  var token = CP.getProperty('SLACK_BOT_TOKEN');
  var ch = CP.getProperty('SLACK_ALERT_CHANNEL') || CP.getProperty('SLACK_CHANNEL_ID');
  if (!token || !ch) { console.log(text); return; }
  UrlFetchApp.fetch('https://slack.com/api/chat.postMessage', {
    method: 'post', contentType: 'application/json; charset=utf-8',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ channel: ch, text: text }), muteHttpExceptions: true
  });
  console.log(text);
}

// ══════════════════════════════════════════════════════════
// 설치·점검
// ══════════════════════════════════════════════════════════
function setupCollectTrigger() {
  var ts = ScriptApp.getProjectTriggers();
  for (var i = 0; i < ts.length; i++) {
    if (ts[i].getHandlerFunction() === 'collectDaily') ScriptApp.deleteTrigger(ts[i]);
  }
  ScriptApp.newTrigger('collectDaily').timeBased().atHour(6).nearMinute(30)
    .inTimezone('Asia/Seoul').everyDays(1).create();
  console.log('매일 06:30 KST 자동 수집을 설정했습니다.');
  console.log('GitHub Actions 의 일일 동기화(07:00)보다 30분 앞서 돕니다.');
}

function testCollect() {
  console.log('── 설정 점검 ──');
  ['SLACK_BOT_TOKEN', 'GITHUB_TOKEN', 'GITHUB_REPO', 'SLACK_ALERT_CHANNEL'].forEach(function (k) {
    console.log('  ' + k + ': ' + (CP.getProperty(k) ? '설정됨' : '❌ 없음'));
  });
  console.log('── 채널 조회 ──');
  수집대상.forEach(function (t) {
    try {
      var f = latestSpreadsheet(t.channel);
      console.log('  ' + t.설명 + ' → ' + (f ? f.name + ' (' + Math.round(f.size / 1024) + 'KB, ' + f.일시 + ')' : '엑셀 없음'));
    } catch (e) { console.log('  ' + t.설명 + ' → ❌ ' + e); }
  });
  console.log('── GitHub 접근 ──');
  try {
    var repo = CP.getProperty('GITHUB_REPO');
    var r = UrlFetchApp.fetch('https://api.github.com/repos/' + repo, {
      headers: { Authorization: 'Bearer ' + CP.getProperty('GITHUB_TOKEN') }, muteHttpExceptions: true });
    console.log('  ' + repo + ' → ' + (r.getResponseCode() === 200 ? '접근 가능' : '❌ ' + r.getResponseCode()));
  } catch (e) { console.log('  ❌ ' + e); }
}
