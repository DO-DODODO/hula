const { chromium } = require('playwright');
const path = require('path');

const URL = 'http://localhost:3999';
const SHOT_DIR = '/tmp/hula-screenshots';
require('fs').mkdirSync(SHOT_DIR, { recursive: true });

function log(who, msg) { console.log(`[${who}] ${msg}`); }
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

async function login(page, who, userCode) {
  const errors = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push('pageerror: ' + err.message));
  await page.goto(URL);
  await page.waitForSelector('#screen-login.active', { timeout: 5000 });
  await page.fill('#input-usercode', userCode);
  await page.click('#btn-login');
  await page.waitForSelector('#screen-main.active', { timeout: 5000 });
  log(who, '로그인 성공');
  return errors;
}

async function main() {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const ctxC = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  const pageC = await ctxC.newPage();

  // C 소켓 이벤트 전부 콘솔로 로깅 (io()가 정의되는 시점에 래핑)
  await pageC.addInitScript(() => {
    const origDefineProperty = Object.defineProperty;
    let realIo = null;
    Object.defineProperty(window, 'io', {
      configurable: true,
      get() { return realIo; },
      set(v) {
        realIo = (...args) => {
          const s = v(...args);
          s.onAny((event, ...a) => console.log('[SOCKET-EVT]', event, JSON.stringify(a).slice(0, 300)));
          const origEmit = s.emit.bind(s);
          s.emit = (event, ...a) => { console.log('[SOCKET-EMIT]', event, JSON.stringify(a).slice(0, 300)); return origEmit(event, ...a); };
          return s;
        };
      }
    });
  });
  pageC.on('console', msg => { if (msg.text().startsWith('[SOCKET')) console.log('C-LOG:', msg.text()); });

  const errA = await login(pageA, 'A', 'dd');
  const errB = await login(pageB, 'B', 'downey');
  const errC = await login(pageC, 'C', 'spec1');

  // A: 방 만들기
  await pageA.click('#btn-multi');
  await pageA.waitForSelector('#screen-multi-lobby.active', { timeout: 5000 });
  await pageA.click('#btn-open-create-room');
  await pageA.fill('#input-room-title', '테스트방');
  await pageA.click('#btn-submit-create-room');
  await pageA.waitForSelector('#screen-waiting.active', { timeout: 5000 });
  log('A', '방 생성 완료, 대기실 진입');

  // B: 방 목록에서 입장
  await pageB.click('#btn-multi');
  await pageB.waitForSelector('#screen-multi-lobby.active', { timeout: 5000 });
  await pageB.waitForTimeout(500);
  await pageB.click('.room-row');
  await pageB.waitForSelector('#screen-waiting.active', { timeout: 5000 });
  log('B', '방 입장 완료');

  await pageB.click('#btn-mark-ready');
  await wait(500);
  await pageA.click('#btn-start-room-game');
  await pageA.waitForSelector('#game-table', { timeout: 8000 });
  await pageB.waitForSelector('#game-table', { timeout: 8000 });
  log('A/B', '게임 시작됨');
  await wait(2000); // 딜링 애니메이션 등 대기

  // C: 로비에서 "게임 중" 방 클릭 → 관전 입장
  await pageC.click('#btn-multi');
  await pageC.waitForSelector('#screen-multi-lobby.active', { timeout: 5000 });
  await pageC.waitForTimeout(800);
  const roomText = await pageC.locator('.room-row .rcount').first().textContent();
  log('C', `로비에 보이는 방 상태: "${roomText}"`);
  await pageC.click('.room-row');
  await pageC.waitForSelector('#game-table', { timeout: 8000 });
  log('C', 'game-table 진입');
  await wait(2500); // 딜링 오버레이 등 사라질 시간

  await pageC.screenshot({ path: path.join(SHOT_DIR, 'spectator-C.png') });
  log('C', '스크린샷 저장');

  // C 화면 DOM 상태 점검
  const state = await pageC.evaluate(() => {
    const g = (id) => document.getElementById(id);
    return {
      gameTableClasses: g('game-table')?.className,
      waiterBadgeDisplay: getComputedStyle(g('waiter-badge')).display,
      waiterBadgeText: g('waiter-badge-text')?.textContent,
      spectatorPanelDisplay: getComputedStyle(g('spectator-panel')).display,
      myAreaDisplay: getComputedStyle(g('my-area')).display,
      spectatorSeat0Name: g('spectator-seat0-name')?.textContent,
      playerTopVisibility: getComputedStyle(g('player-top')).visibility,
      playerTopName: g('player-top')?.querySelector('.player-name')?.textContent,
      playerLeftVisibility: getComputedStyle(g('player-left')).visibility,
      playerLeftName: g('player-left')?.querySelector('.player-name')?.textContent,
      playerRightVisibility: getComputedStyle(g('player-right')).visibility,
      playerRightName: g('player-right')?.querySelector('.player-name')?.textContent,
      deckCount: g('deck-count')?.textContent,
      gameStateExists: typeof gameState !== 'undefined' && !!gameState,
      gameStatePlayers: typeof gameState !== 'undefined' && gameState ? gameState.players.map(p => ({ code: p.userCode, seat: p.seatIndex, hand: p.hand, handCount: p.handCount })) : null,
    };
  });
  console.log('\n=== C(관전자) DOM 상태 ===');
  console.log(JSON.stringify(state, null, 2));

  console.log('\n=== 콘솔/페이지 에러 ===');
  console.log('A:', errA.filter(e => !e.includes('favicon')));
  console.log('B:', errB.filter(e => !e.includes('favicon')));
  console.log('C:', errC.filter(e => !e.includes('favicon')));

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
