const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';
function log(who, msg) { console.log(`[${who}] ${msg}`); }
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

function connectAndLogin(userCode) {
  return new Promise(resolve => {
    const s = io(URL, { forceNew: true });
    s.on('connect', () => s.emit('login', { userCode }));
    s.once('loginSuccess', () => resolve(s));
    s.once('loginError', msg => resolve(null));
    setTimeout(() => resolve(null), 3000);
  });
}
function waitEvent(sock, event, timeoutMs = 6000) {
  return new Promise(resolve => {
    const t = setTimeout(() => resolve(null), timeoutMs);
    sock.once(event, (data) => { clearTimeout(t); resolve(data ?? true); });
  });
}

// 단순 봇: 내 턴이면 덱에서 드로우하고, 바로 아무 카드나 버림 (등록/붙이기는 스킵)
function attachSimpleBot(sock, who) {
  sock.on('gameState', (s) => {
    if (s.status !== 'playing') return;
    const me = s.players.find(p => p.hand);
    if (!me || s.currentPlayerCode !== me.userCode) return;
    if (s.phase === 'draw') {
      setTimeout(() => sock.emit('draw', { source: 'deck' }), 300);
    } else if (s.phase === 'action') {
      const card = me.hand[0];
      if (card) setTimeout(() => sock.emit('discard', { cardId: card.id }), 300);
    }
  });
  sock.on('actionError', msg => log(who, `⚠️ actionError: ${msg}`));
}

async function run() {
  console.log('\n=== 실전 한 판 끝까지 진행 테스트 ===\n');
  const a = await connectAndLogin('kkkyyy123');
  const b = await connectAndLogin('testuser1');
  if (!a || !b) { console.log('로그인 실패'); process.exit(1); }
  for (const s of [a, b]) {
    s.emit('presenceVisible');
    for (const ev of ['joinMultiError', 'createRoomError', 'inviteError', 'adminStartError']) {
      s.on(ev, msg => log(s === a ? 'A' : 'B', `❗ ${ev}: ${JSON.stringify(msg)}`));
    }
  }
  await wait(200);

  a.emit('joinMulti');
  const joinOk = await waitEvent(a, 'joinMultiOk');
  log('A', `joinMulti 결과: ${JSON.stringify(joinOk)}`);

  a.emit('createRoom', { title: '풀게임테스트', code: '', inviteTargets: ['testuser1'] });
  const createOk = await waitEvent(a, 'createRoomOk');
  log('A', `createRoom 결과: ${JSON.stringify(createOk)}`);
  const inv = await waitEvent(b, 'inviteReceived');
  log('B', `초대 수신: ${JSON.stringify(inv)}`);
  b.emit('respondInvite', { accept: true, fromCode: 'kkkyyy123' });
  const accepted = await waitEvent(b, 'inviteAccepted');
  log('B', `초대 수락 결과: ${JSON.stringify(accepted)}`);
  b.emit('joinRoomViaInvite');
  const joinedRoom = await waitEvent(b, 'joinMultiOk');
  log('B', `방 입장 결과: ${JSON.stringify(joinedRoom)}`);
  await wait(300);

  b.emit('markRoomReady');
  const waitState = await waitEvent(a, 'roomWaiting');
  log('A', `대기실 상태: ${JSON.stringify(waitState)}`);
  await wait(200);

  attachSimpleBot(a, 'A');
  attachSimpleBot(b, 'B');

  let gameEnded = false;
  let turnCount = 0;
  let errorCount = 0;
  a.on('gameState', () => turnCount++);
  a.on('actionError', () => errorCount++);
  b.on('actionError', () => errorCount++);

  const endPromiseA = new Promise(resolve => a.once('gameEnd', resolve));
  const endPromiseB = new Promise(resolve => b.once('gameEnd', resolve));

  a.emit('startRoomGame');
  const started = await waitEvent(a, 'gameState', 8000);
  if (!started) { console.log('❌ 게임 시작 자체가 안 됨'); process.exit(1); }
  log('A', `게임 시작됨, game_id=${started.id}, deck=${started.deck.count}`);

  console.log('게임 진행 중... (최대 90초 대기)');
  const result = await Promise.race([
    Promise.all([endPromiseA, endPromiseB]).then(([ra]) => ra),
    wait(90000).then(() => null),
  ]);

  if (!result) {
    console.log(`\n❌ 90초 안에 게임이 안 끝남. 지금까지 gameState 수신 ${turnCount}회, 에러 ${errorCount}건`);
    process.exit(1);
  }

  console.log('\n✅ 게임 정상 종료!');
  console.log('승자:', result.winnerName, result.winnerCode);
  console.log('훌라 여부:', result.isHula, '2배 이벤트:', result.isDoubleEvent);
  console.log('결과 목록:');
  for (const r of result.results) {
    console.log(`  - ${r.userName} (${r.userCode}) rank=${r.rank} ${r.isAI ? '[AI]' : '[사람]'}`);
  }
  console.log(`\ngameState 수신 총 ${turnCount}회, actionError ${errorCount}건`);
  console.log(errorCount === 0 ? '✅ 에러 없이 한 판 완주' : '❌ 에러 발생함');

  a.disconnect(); b.disconnect();
  process.exit(errorCount === 0 ? 0 : 1);
}
run().catch(e => { console.error('에러:', e); process.exit(1); });
