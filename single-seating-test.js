const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';
function log(msg) { console.log(msg); }
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
function waitEvent(sock, event, timeoutMs = 6000) {
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
    if (s.phase === 'draw') setTimeout(() => sock.emit('draw', { source: 'deck' }), 100);
    else if (s.phase === 'action') { const c = me.hand[0]; if (c) setTimeout(() => sock.emit('discard', { cardId: c.id }), 100); }
  });
}

async function run() {
  const s = new Promise(resolve => {
    const sock = io(URL, { forceNew: true });
    sock.on('connect', () => sock.emit('login', { userCode: 'testuser1' }));
    sock.once('loginSuccess', () => resolve(sock));
  });
  const sock = await s;
  sock.emit('presenceVisible');
  await wait(200);

  attachSimpleBot(sock);
  sock.emit('startSingle', {});
  const state1 = await waitEvent(sock, 'gameState', 8000);
  const order1 = state1.players.map(p => p.userCode);
  log('1판 좌석 순서: ' + order1.join(' - '));

  const end1 = await waitEvent(sock, 'gameEnd', 120000);
  if (!end1) { log('❌ 1판이 끝나지 않음'); process.exit(1); }
  log(`1판 승자: ${end1.winnerName} (${end1.winnerCode})`);
  const winnerIdx1 = order1.indexOf(end1.winnerCode);
  const expectedOrder2 = [...order1.slice(winnerIdx1), ...order1.slice(0, winnerIdx1)];
  log('기대하는 2판 순서(승자부터 원래 순서 유지): ' + expectedOrder2.join(' - '));

  await wait(500);
  sock.emit('startSingle', { continued: true });
  const state2 = await waitEvent(sock, 'gameState', 8000);
  const order2 = state2.players.map(p => p.userCode);
  log('실제 2판 좌석 순서: ' + order2.join(' - '));

  const isWinnerHuman = end1.winnerCode === 'testuser1';
  const match = isWinnerHuman
    ? order2[0] === 'testuser1' // 사람이 이기면 사람이 항상 선공
    : JSON.stringify(order2) === JSON.stringify(expectedOrder2);
  console.log(match ? '✅ 2판 순서가 기대한 대로 회전됨' : '❌ 2판 순서가 기대와 다름');

  sock.disconnect();
  process.exit(match ? 0 : 1);
}
run().catch(e => { console.error(e); process.exit(1); });
