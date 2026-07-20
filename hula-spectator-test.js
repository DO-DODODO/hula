const { io } = require('socket.io-client');
const URL = 'http://localhost:3999';

function log(who, msg) { console.log(`[${who}] ${msg}`); }
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

function connectAndLogin(userCode) {
  return new Promise(resolve => {
    const s = io(URL, { transports: ['websocket'], forceNew: true });
    s.on('connect', () => { s.emit('presenceVisible'); s.emit('login', { userCode }); });
    s.once('loginSuccess', () => resolve(s));
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

// 내 턴이면 드로우 후 바로 아무 카드나 버리는 단순 봇 (등록/붙이기 스킵) — 게임을 빠르게 끝내기 위함
function attachSimpleBot(sock, who) {
  sock.on('gameState', (s) => {
    if (s.status !== 'playing') return;
    const me = s.players.find(p => p.hand);
    if (!me || s.currentPlayerCode !== me.userCode) return;
    if (s.phase === 'draw') {
      setTimeout(() => sock.emit('draw', { source: 'deck' }), 80);
    } else if (s.phase === 'action') {
      const card = me.hand[0];
      if (card) setTimeout(() => sock.emit('discard', { cardId: card.id }), 80);
    }
  });
}

async function run() {
  console.log('\n=== 관전(대기) 모드 기능 테스트 ===\n');
  const A = await connectAndLogin('dd');       // 방장
  const B = await connectAndLogin('downey');   // 참가자
  const C = await connectAndLogin('spec1');    // 대기자 1
  const D = await connectAndLogin('spec2');    // 대기자 2
  const E = await connectAndLogin('spec3');    // 대기자 3 (정원 초과되어야 함)
  if (!A || !B || !C || !D || !E) { console.log('로그인 실패'); process.exit(1); }

  attachSimpleBot(A, 'A'); attachSimpleBot(B, 'B');
  A.on('gameEnd', () => log('A', '🏁 gameEnd 수신'));
  const waiterListSeenByA = [];
  A.on('waiterList', (d) => waiterListSeenByA.push(d));
  let cGotGameEnd = false, cReadyStatus = null;
  C.on('gameEnd', () => { cGotGameEnd = true; });
  C.on('readyStatus', (d) => { cReadyStatus = d; });

  // 1) 방 생성 + B 입장 + 준비 + 시작
  A.emit('createRoom', { title: '관전테스트방' });
  const created = await once(A, 'createRoomOk');
  const roomId = created.roomId;
  log('A', `방 생성됨 roomId=${roomId}`);

  B.emit('joinRoomByList', { roomId });
  await once(B, 'joinMultiOk');
  B.emit('markRoomReady');
  await wait(200);
  A.emit('startRoomGame');
  await once(A, 'gameState');
  log('A', '게임 시작됨 (A, B + AI 2명)');
  await wait(500);

  // 2) C, D 관전 입장 (정원 4 - 현재인원 2 = 대기 가능 2명)
  C.emit('joinRoomByList', { roomId });
  const cRes = await Promise.race([once(C, 'spectateOk'), once(C, 'joinMultiError')]);
  log('C', `입장 결과: ${JSON.stringify(cRes)}`);

  D.emit('joinRoomByList', { roomId });
  const dRes = await Promise.race([once(D, 'spectateOk'), once(D, 'joinMultiError')]);
  log('D', `입장 결과: ${JSON.stringify(dRes)}`);

  // 3) E는 정원 초과로 막혀야 함
  E.emit('joinRoomByList', { roomId });
  const eRes = await Promise.race([once(E, 'spectateOk'), once(E, 'joinMultiError')]);
  log('E', `입장 결과(정원 초과 예상): ${JSON.stringify(eRes)}`);

  // 4) C가 실제로 게임 상태(gameState)를 받는지, 손패가 안 보이는지 확인
  const cGameState = await once(C, 'gameState', 2000) || await new Promise(r => { C.once('gameState', r); setTimeout(() => r(null), 2000); });
  if (cGameState) {
    const handsAllHidden = cGameState.players.every(p => p.hand === null);
    log('C', `gameState 수신, 전원 손패 숨김 여부: ${handsAllHidden}`);
  } else {
    log('C', '⚠️ gameState 수신 안 됨 (이미 첫 이벤트는 spectateOk 처리 중 소비됐을 수 있음, 아래 waiterList로 대체 확인)');
  }

  // 5) waiterList가 A(플레이어)에게도 왔었는지 확인 (C, D 입장 시점에 이미 왔어야 함)
  log('A', `A가 받은 waiterList 이력: ${JSON.stringify(waiterListSeenByA)}`);

  // 6) 로비 방 목록에 대기 현황이 뜨는지 확인
  A.emit('listRooms');
  const roomList = await once(A, 'roomList');
  const roomRow = roomList.rooms.find(r => r.id === roomId);
  log('A', `방 목록 표시: playing=${roomRow.playing}, memberCount=${roomRow.memberCount}, waitingCount=${roomRow.waitingCount}, waitingCap=${roomRow.waitingCap}`);

  // 7) 게임이 끝날 때까지 대기 (봇이 자동 진행) — 최대 60초
  console.log('\n--- 게임 종료 대기 중 (봇 자동 진행, 최대 60초) ---');
  const ended = await once(A, 'gameEnd', 240000);
  if (!ended) { console.log('⚠️ 60초 내에 게임이 안 끝남 — 이후 단계 스킵'); }
  else {
    log('A', '게임 종료됨');
    await wait(500);

    // 8) 대기자도 gameEnd/readyStatus를 받는지 확인 (결과 화면 + 준비 버튼 노출용)
    log('C', `대기자가 gameEnd 수신: ${cGotGameEnd}, readyStatus: ${JSON.stringify(cReadyStatus)}`);

    // C, D 준비 완료
    C.emit('readyForNextGame');
    D.emit('readyForNextGame');
    B.emit('readyForNextGame');
    await wait(500);

    // 9) A(방장)가 playAgain → C, D가 AI 자리를 대체해서 실제 플레이어로 편입되는지 확인
    A.emit('playAgain');
    const newState = await once(A, 'gameState', 3000);
    if (newState) {
      const humanCodes = newState.players.filter(p => !p.isAI).map(p => p.userCode);
      log('A', `다음 판 실제 플레이어: ${JSON.stringify(humanCodes)} (spec1, spec2가 포함되어야 함)`);
    } else {
      log('A', '⚠️ playAgain 이후 gameState 수신 안 됨');
    }
  }

  console.log('\n=== 테스트 종료 ===');
  [A, B, C, D, E].forEach(s => s?.disconnect());
  process.exit(0);
}

run().catch(e => { console.error(e); process.exit(1); });
