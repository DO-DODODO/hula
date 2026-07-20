const { io } = require('socket.io-client');
const URL = 'http://localhost:3999';

function log(who, msg) { console.log(`[${who}] ${msg}`); }
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

function connectAndLogin(userCode) {
  return new Promise(resolve => {
    const s = io(URL, { transports: ['websocket'], forceNew: true });
    s.on('connect', () => { s.emit('presenceVisible'); s.emit('login', { userCode }); });
    s.once('loginSuccess', () => { s.emit('presenceVisible'); resolve(s); });
    s.once('loginError', msg => { console.log('loginError', msg); resolve(null); });
    setTimeout(() => resolve(null), 4000);
  });
}
function once(sock, event, timeoutMs = 6000) {
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
    if (s.phase === 'draw') setTimeout(() => sock.emit('draw', { source: 'deck' }), 80);
    else if (s.phase === 'action') { const c = me.hand[0]; if (c) setTimeout(() => sock.emit('discard', { cardId: c.id }), 80); }
  });
}

async function main() {
  console.log('\n=== 이슈2: 준비 단계 중 혼자 남으면 메인으로 돌아가는지 검증 ===\n');
  const A = await connectAndLogin('dd');
  const B = await connectAndLogin('downey');
  attachSimpleBot(A); attachSimpleBot(B);

  A.emit('createRoom', { title: '혼자남기테스트' });
  const created = await once(A, 'createRoomOk');
  const roomId = created.roomId;
  B.emit('joinRoomByList', { roomId });
  await once(B, 'joinMultiOk');
  B.emit('markRoomReady');
  await wait(300);
  A.emit('startRoomGame');
  await once(A, 'gameState');
  log('A/B', '게임 시작, 봇이 끝까지 진행합니다 (최대 240초 대기)');

  const ended = await once(A, 'gameEnd', 240000);
  if (!ended) { console.log('⚠️ 게임이 제 시간 안에 안 끝남'); process.exit(1); }
  log('A', '게임 종료, 이제 B를 강제로 끊습니다 (재접속 없이)');
  await wait(500);

  // A가 남아서 playAgainError를 받는지 확인
  const errPromise = once(A, 'playAgainError', 15000);
  B.disconnect(); // 재접속 안 함 = 진짜로 나간 것처럼

  const err = await errPromise;
  console.log('\n=== 결과 ===');
  if (err) console.log(`✅ 정상 — A가 playAgainError 수신: "${err}"`);
  else console.log('❌ A가 아무 알림도 못 받음 (메인으로 안 돌아감)');

  A.disconnect();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
