const { chromium } = require('playwright');
const URL = 'http://localhost:3000';
function log(who, msg) { console.log(`[${who}] ${msg}`); }
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

async function login(page, userCode) {
  await page.goto(URL);
  await page.waitForSelector('#screen-login.active');
  await page.fill('#input-usercode', userCode);
  await page.click('#btn-login');
  await page.waitForSelector('#screen-main.active');
}

async function playUntilEnd(page) {
  for (let i = 0; i < 200; i++) {
    const state = await page.evaluate(() => (typeof gameState !== 'undefined' && gameState) ? { status: gameState.status, cur: gameState.currentPlayerCode, phase: gameState.phase, my: userCode } : null);
    if (!state) { await wait(300); continue; }
    if (state.status === 'ended') return;
    if (state.cur === state.my) {
      if (state.phase === 'draw') await page.click('#deck-card').catch(() => {});
      else if (state.phase === 'action') {
        const first = page.locator('#my-hand .card-slot').first();
        if (await first.count() > 0) { await first.click().catch(() => {}); await page.click('#btn-discard').catch(() => {}); }
      }
    }
    await wait(400);
  }
}

async function main() {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  await login(pageA, 'kkkyyy123'); // 방장
  await login(pageB, 'testuser1'); // 참가자

  await pageA.click('#btn-multi');
  await pageA.waitForSelector('#screen-multi-lobby.active');
  await pageA.click('#btn-open-create-room');
  await pageA.fill('#input-room-title', '한판더브라우저');
  await pageA.click('#btn-submit-create-room');
  await pageA.waitForSelector('#screen-waiting.active');

  await pageB.click('#btn-multi');
  await pageB.waitForSelector('#screen-multi-lobby.active');
  await pageB.waitForSelector('.room-row');
  await pageB.click('.room-row');
  await pageB.waitForSelector('#screen-waiting.active');
  await pageA.waitForFunction(() => document.querySelectorAll('#waiting-players .waiting-player').length === 2);

  await pageB.click('#btn-mark-ready');
  await pageA.waitForFunction(() => !document.getElementById('btn-start-room-game').disabled);
  await pageA.click('#btn-start-room-game');
  await Promise.all([pageA.waitForURL(/game\.html/), pageB.waitForURL(/game\.html/)]);
  log('A', '게임 시작됨, 끝날 때까지 진행...');

  await Promise.all([playUntilEnd(pageA), playUntilEnd(pageB)]);
  log('A', '게임 종료 감지됨');

  // 정산 결과 화면까지 이동 (게임종료 오버레이 확인 버튼)
  await pageA.waitForSelector('#overlay-gameend', { state: 'visible', timeout: 15000 }).catch(() => {});
  await pageA.click('#btn-gameend-ok').catch(() => {});
  await pageB.waitForSelector('#overlay-gameend', { state: 'visible', timeout: 15000 }).catch(() => {});
  await pageB.click('#btn-gameend-ok').catch(() => {});
  await wait(1000);

  await pageA.screenshot({ path: '/tmp/hula-screenshots/results-A-host.png' });
  await pageB.screenshot({ path: '/tmp/hula-screenshots/results-B-member.png' });
  log('A', '정산결과 화면 스크린샷 저장');

  // 방장(A)의 "한 판 더" 버튼 비활성 상태 확인
  const againDisabled = await pageA.isDisabled('#btn-results-again');
  console.log(againDisabled ? '✅ 방장: 참가자 준비 전 "한 판 더" 비활성' : '❌ 방장 버튼이 처음부터 활성화되어 있음(문제)');

  // 참가자(B) 준비 버튼 클릭
  await pageB.click('#btn-results-ready');
  await pageA.waitForFunction(() => !document.getElementById('btn-results-again').disabled, { timeout: 10000 }).catch(() => {});
  const againDisabledAfter = await pageA.isDisabled('#btn-results-again');
  console.log(!againDisabledAfter ? '✅ 참가자 준비 후 방장 "한 판 더" 활성화됨' : '❌ 참가자 준비해도 여전히 비활성');
  await pageA.screenshot({ path: '/tmp/hula-screenshots/results-A-after-ready.png' });

  await browser.close();
  process.exit((!againDisabledAfter && againDisabled) ? 0 : 1);
}
main().catch(e => { console.error('에러:', e); process.exit(1); });
