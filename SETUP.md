# GitHub 업로드 절차 (터미널 사용)

> 터미널 없이 웹 화면만으로 구축하시려면 **[START-HERE.md](START-HERE.md)** 를 보십시오.
> 이 문서는 git 명령을 쓰는 경우의 절차입니다.

## 1. 리포지토리 생성 (⚠ Private)

GitHub `LEESUNGHO-AI` 조직에서 새 리포지토리를 만든다.

| 항목 | 값 |
|---|---|
| Repository name | `Asan-Smartcity-Settlement-System` |
| Visibility | **Private** ← 반드시 |
| Add README | 체크 해제 (이미 포함됨) |
| .gitignore / license | 없음 (이미 포함됨) |

> 참여인력·평가위원의 성명과 생년월일이 포함된다. Public으로 만들면 안 된다.

## 2. 업로드

이 폴더에는 이미 `.git`이 초기화되어 있고 최초 커밋이 들어 있다.
원격만 연결해서 push하면 된다.

```bash
cd Asan-Smartcity-Settlement-System

git remote add origin https://github.com/LEESUNGHO-AI/Asan-Smartcity-Settlement-System.git
git branch -M main
git push -u origin main
```

`.git`이 없는 상태로 받았다면:

```bash
git init
git add -A
git commit -m "feat: 아산시 강소형 스마트시티 정산시스템 초기 구축"
git branch -M main
git remote add origin https://github.com/LEESUNGHO-AI/Asan-Smartcity-Settlement-System.git
git push -u origin main
```

## 3. 리포지토리 설정

### 브랜치 보호 (Settings → Branches → Add rule)

| 설정 | 값 |
|---|---|
| Branch name pattern | `main` |
| Require a pull request before merging | ✔ (승인 1인) |
| Require status checks to pass | ✔ → `validate` 선택 |
| Do not allow bypassing | ✔ |

원장을 직접 수정하지 못하게 막는 것이 핵심이다. 모든 변경은 PR로 들어오고,
검증을 통과해야 머지된다.

### 접근 권한 (Settings → Collaborators and teams)

| 역할 | 권한 |
|---|---|
| PMO 총괄 (상무 이성호) | Admin |
| PMO 정산 담당 | Write |
| 컨소시엄 기관 담당자, 검증기관 | Read |

### Actions 확인 (Settings → Actions → General)

- Workflow permissions: `Read repository contents` 로 충분
- Fork로부터의 workflow 실행: 비활성화

## 4. 최초 CI 결과

push 직후 `원장 검증` 워크플로가 **실패한다. 정상이다.**

```
✗ R-01  기준정보 미확정: 준공기준시점, 총사업비, 회계감사대상
✗ R-03  CT-2026-0001 계약서 등록 지연 20일
✗ R-06  무형자산 3건(38.25억) 중요재산 미등재
✗ R-11  낙찰차액 80,000,000원
```

시스템이 현재 정산 상태의 결함을 정확히 지적하고 있는 것이다.
해소하면 자동으로 통과한다. 통과 전까지 보고서 산출은 차단된다.

## 5. 동작 확인

```bash
npm install
npm run validate
npm run report -- --org JEIL --from 2025-10-01 --to 2026-06-30
```

`output/`에 집행결과 제출 양식 DOCX가 생성되면 정상이다.

GitHub에서는 Actions → `집행결과 제출 양식 생성` → Run workflow로 실행하면
검증 통과 시에만 DOCX가 Artifact로 나온다.
