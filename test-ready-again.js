const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';
let passed = 0, failed = 0;
function ok(label, cond) { if (cond) { console.log(`  ✅ ${label}`); passed++; } else { console.log(`  ❌ ${label}`); failed++; } }
function log(who, msg) { console.log(`[${who}] ${msg}`); }
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
function connectAndLogin(userCode) {
  return new Promise(resolve => {
    const s = io(URL, { forceNew: true });
    s.on('connect', () => { log(userCode, '🔌 connect (재접속 포함)'); s.emit('login', { userCode }); });
    s.on('disconnect', (reason) => log(userCode, `🔌❌ disconnect: ${reason}`));
    s.once('loginSuccess', () => resolve(s));
    setTimeout(() => resolve(null), 3000);
  });
}
function waitEvent(sock, event, timeoutMs = 8000) {
  return new Promise(resolve => {
    const t = setTimeout(() => resolve(null), timeoutMs);
    sock.once(event, (data) => { clearTimeout(t); resolve(data ?? true); });
  });
}
function attachSimpleBot(sock) {
  sock.on('gameState', (s) => {
    if (s.status !== 'playing') return;
    const me = s.players.find(p => p.hand);
    if (!me || s.currentPlayerCode !== me.userCode) return;
    if (s.phase === 'draw') setTimeout(() => sock.emit('draw', { source: 'deck' }), 200);
    else if (s.phase === 'action') { const c = me.hand[0]; if (c) setTimeout(() => sock.emit('discard', { cardId: c.id }), 200); }
  });
}

async function run() {
  console.log('\n=== "한 판 더" 준비 흐름 테스트 ===\n');
  const a = await connectAndLogin('kkkyyy123'); // 방장
  const b = await connectAndLogin('testuser1'); // 참가자
  for (const s of [a, b]) s.emit('presenceVisible');
  await wait(200);

  a.emit('joinMulti');
  await waitEvent(a, 'joinMultiOk');
  a.emit('createRoom', { title: '한판더테스트', code: '', inviteTargets: ['testuser1'] });
  await waitEvent(a, 'createRoomOk');
  await waitEvent(b, 'inviteReceived');
  b.emit('respondInvite', { accept: true, fromCode: 'kkkyyy123' });
  await waitEvent(b, 'inviteAccepted');
  b.emit('joinRoomViaInvite');
  await waitEvent(b, 'joinMultiOk');
  await wait(300);
  b.emit('markRoomReady');
  await wait(300);

  a.onAny((event) => { if (event !== 'gameState') console.log('[A received event]', event); });

  attachSimpleBot(a); attachSimpleBot(b);
  const endA = waitEvent(a, 'gameEnd', 60000);
  const endB = waitEvent(b, 'gameEnd', 60000);
  const readyStatusPromise = waitEvent(a, 'readyStatus', 65000); // gameEnd 직후 바로 올 수 있으니 미리 등록
  a.emit('startRoomGame');
  await waitEvent(a, 'gameState', 8000);
  log('A', '게임 시작, 종료까지 대기...');
  await Promise.all([endA, endB]);
  log('A', '게임 종료됨');

  // ── readyStatus: 방장(a)은 requiredCodes에서 빠져야 함 ─────────────────
  const readyStatus = await readyStatusPromise;
  log('A', `readyStatus: ${JSON.stringify(readyStatus)}`);
  ok('방장(kkkyyy123)은 requiredCodes에서 제외됨', readyStatus && !readyStatus.requiredCodes.includes('kkkyyy123'));
  ok('참가자(testuser1)는 requiredCodes에 포함됨', readyStatus && readyStatus.requiredCodes.includes('testuser1'));

  // ── b가 준비 누르기 전엔 playAgain 시도해도 (클라단에서 막혀야 하지만) 서버도 막아야 함 ──
  a.emit('playAgain');
  const blockedTry = await waitEvent(a, 'gameState', 2000); // 새 게임 오면 안 됨(막혀야 하니까 null이어야 정상)
  ok('참가자 준비 전엔 방장이 playAgain해도 안 됨', !blockedTry);

  // ── b가 준비 완료 ──────────────────────────────────────────────────
  const readyStatus2Promise = waitEvent(a, 'readyStatus', 5000);
  b.emit('readyForNextGame');
  const readyStatus2 = await readyStatus2Promise;
  log('A', `준비 후 readyStatus: ${JSON.stringify(readyStatus2)}`);
  ok('참가자 준비 완료로 readyCodes에 반영됨', readyStatus2 && readyStatus2.readyCodes.includes('testuser1'));

  // ── 이제 방장이 playAgain하면 새 게임 시작돼야 함 ─────────────────────
  a.emit('playAgain');
  const newGame = await waitEvent(a, 'gameState', 5000);
  ok('전원 준비 후 방장 playAgain으로 새 게임 시작됨', !!newGame && newGame.status === 'playing');
  ok('새 게임에도 hostCode가 방장으로 찍힘', newGame?.hostCode === 'kkkyyy123');

  console.log(`\n=== 결과: ✅ ${passed}개 통과 / ❌ ${failed}개 실패 ===`);
  a.disconnect(); b.disconnect();
  process.exit(failed > 0 ? 1 : 0);
}
run().catch(e => { console.error(e); process.exit(1); });
