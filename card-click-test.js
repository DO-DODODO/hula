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

async function main() {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  pageA.on('pageerror', e => console.log('[A pageerror]', e.message));
  pageB.on('pageerror', e => console.log('[B pageerror]', e.message));
  pageA.on('console', m => { if (m.type() === 'error') console.log('[A console error]', m.text()); });
  pageB.on('console', m => { if (m.type() === 'error') console.log('[B console error]', m.text()); });

  await login(pageA, 'kkkyyy123');
  await login(pageB, 'testuser1');

  await pageA.click('#btn-multi');
  await pageA.waitForSelector('#screen-multi-lobby.active');
  await pageA.click('#btn-open-create-room');
  await pageA.waitForSelector('#modal-create-room[style*="flex"]');
  await pageA.fill('#input-room-title', '카드클릭테스트');
  await pageA.click('#btn-submit-create-room');
  await pageA.waitForSelector('#screen-waiting.active');

  await pageB.click('#btn-multi');
  await pageB.waitForSelector('#screen-multi-lobby.active');
  await pageB.waitForSelector('.room-row');
  await pageB.click('.room-row');
  await pageB.waitForSelector('#screen-waiting.active');
  await pageA.waitForFunction(() => document.querySelectorAll('#waiting-players .waiting-player').length === 2);

  // ── 방장 X버튼이 상대방 줄에 보이는지 확인 ──────────────────────────────
  const kickBtnVisible = await pageA.isVisible('.kick-x');
  log('A', `방장 화면에 X(내보내기) 버튼 보임: ${kickBtnVisible}`);

  await pageB.click('#btn-mark-ready');
  await pageA.waitForFunction(() => !document.getElementById('btn-start-room-game').disabled);
  await pageA.click('#btn-start-room-game');
  await Promise.all([
    pageA.waitForURL(/game\.html/, { timeout: 8000 }),
    pageB.waitForURL(/game\.html/, { timeout: 8000 }),
  ]);
  log('A', '게임 화면 진입');

  await pageA.waitForSelector('#my-hand .card-slot', { timeout: 8000 });
  await wait(4000); // 2배 이벤트 연출 등 안정화 대기 + AI 턴 넘어갈 시간

  // ── 사람(A 또는 B) 차례가 될 때까지 최대 30초 대기 ─────────────────────
  let myPage = null, myWho = null;
  for (let i = 0; i < 15; i++) {
    const turnA = await pageA.evaluate(() => (typeof gameState !== 'undefined' && gameState) ? { cur: gameState.currentPlayerCode, phase: gameState.phase, my: userCode } : null);
    if (turnA && turnA.cur === turnA.my) { myPage = pageA; myWho = 'A'; break; }
    const turnB = await pageB.evaluate(() => (typeof gameState !== 'undefined' && gameState) ? { cur: gameState.currentPlayerCode, phase: gameState.phase, my: userCode } : null);
    if (turnB && turnB.cur === turnB.my) { myPage = pageB; myWho = 'B'; break; }
    await wait(2000);
  }
  if (!myPage) { console.log('❌ 30초 동안 사람 차례가 안 옴'); await browser.close(); process.exit(1); }
  log(myWho, '내 차례 확인됨');

  const phase = await myPage.evaluate(() => gameState.phase);
  log(myWho, `현재 phase: ${phase}`);
  if (phase === 'draw') {
    await myPage.click('#deck-card');
    await wait(800);
    log(myWho, '덱에서 드로우 클릭함');
  }

  // ── 실제로 카드 클릭 → selected 클래스 붙는지 확인 ──────────────────────
  const firstCard = myPage.locator('#my-hand .card-slot').first();
  const beforeClass = await firstCard.getAttribute('class');
  await firstCard.click();
  await wait(300);
  const afterClass = await firstCard.getAttribute('class');
  log(myWho, `클릭 전 class: "${beforeClass}"`);
  log(myWho, `클릭 후 class: "${afterClass}"`);
  const selected = afterClass?.includes('selected');
  console.log(selected ? '✅ 카드 클릭 시 선택(selected) 처리됨' : '❌ 카드 클릭해도 selected 안 붙음');

  await page_screenshot(myPage, 'card-click-after');

  await browser.close();
  process.exit(selected && kickBtnVisible ? 0 : 1);
}

async function page_screenshot(page, name) {
  await page.screenshot({ path: `/tmp/hula-screenshots/${name}.png` });
  console.log(`  📸 /tmp/hula-screenshots/${name}.png`);
}

main().catch(e => { console.error('에러:', e); process.exit(1); });
