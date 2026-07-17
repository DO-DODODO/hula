const { chromium } = require('playwright');
const path = require('path');

const URL = 'http://localhost:3000';
const SHOT_DIR = '/tmp/hula-screenshots';
require('fs').mkdirSync(SHOT_DIR, { recursive: true });

function log(who, msg) { console.log(`[${who}] ${msg}`); }
let passed = 0, failed = 0;
function ok_assert(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else { console.log(`  ❌ ${label}`); failed++; }
}

async function shot(page, name) {
  const p = path.join(SHOT_DIR, name + '.png');
  await page.screenshot({ path: p });
  console.log(`  📸 ${p}`);
}

async function login(page, who, userCode) {
  const errors = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push('pageerror: ' + err.message));
  await page.goto(URL);
  await page.waitForSelector('#screen-login.active', { timeout: 5000 });
  await page.fill('#input-usercode', userCode);
  await page.click('#btn-login');
  await page.waitForSelector('#screen-main.active', { timeout: 5000 });
  log(who, `로그인 성공, 메인화면 진입`);
  return errors;
}

async function main() {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  const errorsA = await login(pageA, 'A(testuser1)', 'testuser1');
  const errorsB = await login(pageB, 'B(testuser2)', 'testuser2');

  // ── A: 멀티모드 진입 → 로비 (입장코드 없이 바로) ───────────────────────
  await pageA.click('#btn-multi');
  await pageA.waitForSelector('#screen-multi-lobby.active', { timeout: 5000 });
  log('A', '로비 진입 성공');
  await shot(pageA, '01-A-lobby-empty');

  // ── A: 방 만들기 (코드 없음) ─────────────────────────────────────────
  await pageA.click('#btn-open-create-room');
  await pageA.waitForSelector('#modal-create-room[style*="flex"]');
  await pageA.fill('#input-room-title', '브라우저테스트방');
  await shot(pageA, '02-A-create-room-modal');
  await pageA.click('#btn-submit-create-room');
  await pageA.waitForSelector('#screen-waiting.active', { timeout: 5000 });
  const roomTitleText = await pageA.textContent('#waiting-room-title');
  log('A', `대기실 진입, 방 제목: ${roomTitleText}`);
  await shot(pageA, '03-A-waiting-room-alone');

  // ── B: 멀티모드 진입 → 로비 → 방 목록에서 클릭 입장 ────────────────────
  await pageB.click('#btn-multi');
  await pageB.waitForSelector('#screen-multi-lobby.active', { timeout: 5000 });
  await pageB.waitForSelector('.room-row', { timeout: 5000 });
  const roomRowText = await pageB.textContent('.room-row .rname');
  log('B', `방 목록에서 발견: ${roomRowText}`);
  await shot(pageB, '04-B-lobby-with-room');

  await pageB.click('.room-row');
  await pageB.waitForSelector('#screen-waiting.active', { timeout: 5000 });
  log('B', '방 목록 클릭으로 대기실 입장 성공 (코드 불필요, 공개방)');
  await shot(pageB, '05-B-waiting-room-joined');

  // ── A쪽 화면도 2명으로 갱신됐는지 확인 ────────────────────────────────
  await pageA.waitForFunction(() => document.querySelectorAll('#waiting-players .waiting-player').length === 2, { timeout: 5000 });
  log('A', 'A 화면에도 2명으로 갱신 확인');
  await shot(pageA, '06-A-waiting-room-2players');

  // ── 방장(A)의 시작 버튼은 B가 준비하기 전엔 비활성 상태여야 함 ────────────
  const startDisabledBefore = await pageA.isDisabled('#btn-start-room-game');
  ok_assert('방장 시작버튼이 B 준비 전엔 비활성', startDisabledBefore);

  // ── B(방장 아님): 준비 버튼 클릭 ───────────────────────────────────────
  await pageB.click('#btn-mark-ready');
  await pageA.waitForFunction(() => !document.getElementById('btn-start-room-game').disabled, { timeout: 5000 });
  log('B', '준비 완료 클릭, A(방장) 시작버튼 활성화됨');
  await shot(pageA, '06b-A-start-enabled-after-ready');

  // ── B가 시작 버튼을 눌러도 막혀야 함 (방장만 가능) ─────────────────────
  pageA.on('console', msg => { if (msg.type() === 'error') console.log('  [A console error]', msg.text()); });
  const bHasStartBtn = await pageB.isVisible('#btn-start-room-game');
  ok_assert('B(방장 아님) 화면엔 게임시작 버튼 자체가 안 보임', !bHasStartBtn);

  // ── A(방장): 게임 시작 ────────────────────────────────────────────────
  await pageA.click('#btn-start-room-game');
  await Promise.all([
    pageA.waitForURL(/game\.html/, { timeout: 8000 }),
    pageB.waitForURL(/game\.html/, { timeout: 8000 }),
  ]);
  log('A', '방장이 게임 시작, 양쪽 다 game.html로 이동');

  // ── 진짜 게임 상태를 받았는지: 내 패(카드 7장)가 실제로 렌더링됐는지 확인 ──
  await pageA.waitForSelector('#my-hand .card-slot', { timeout: 8000 }).catch(() => null);
  await pageB.waitForSelector('#my-hand .card-slot', { timeout: 8000 }).catch(() => null);
  const aCards = await pageA.locator('#my-hand .card-slot').count();
  const bCards = await pageB.locator('#my-hand .card-slot').count();
  ok_assert('A(방장) 실제 카드 패 렌더링됨 (7장)', aCards === 7);
  ok_assert('B(참가자) 실제 카드 패 렌더링됨 (7장) — 재접속 버그 있었으면 0장', bCards === 7);
  log('A', `A 카드 수: ${aCards}`);
  log('B', `B 카드 수: ${bCards}`);

  await shot(pageA, '07-A-game-screen');
  await shot(pageB, '08-B-game-screen');

  // ── 10초 관찰: 실제로 턴이 진행되는지(내 턴 하이라이트/타이머 등) ──────────
  await pageA.waitForTimeout(6000);
  const aStillHasCards = await pageA.locator('#my-hand .card-slot').count();
  const bStillHasCards = await pageB.locator('#my-hand .card-slot').count();
  ok_assert('6초 후에도 A 화면 살아있음(카드 유지/변화)', aStillHasCards > 0);
  ok_assert('6초 후에도 B 화면 살아있음(카드 유지/변화)', bStillHasCards > 0);
  await shot(pageA, '09-A-after-6s');
  await shot(pageB, '10-B-after-6s');

  console.log('\n--- 콘솔 에러 체크 ---');
  console.log('A errors:', errorsA.length ? errorsA : '없음');
  console.log('B errors:', errorsB.length ? errorsB : '없음');
  console.log(`\n=== 결과: ✅ ${passed}개 통과 / ❌ ${failed}개 실패 ===`);

  await browser.close();
  console.log('\n✅ 브라우저 테스트 완료');
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error('❌ 테스트 실패:', e); process.exit(1); });
