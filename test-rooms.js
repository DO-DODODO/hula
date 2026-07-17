const { io } = require('socket.io-client');

const URL = 'http://localhost:3000';
const log = (who, msg) => console.log(`[${who}] ${msg}`);
let passed = 0, failed = 0;

function ok(label, cond) {
  if (cond) { console.log(`  ✅ ${label}`); passed++; }
  else       { console.log(`  ❌ ${label}`); failed++; }
}

function connectAndLogin(userCode) {
  return new Promise(resolve => {
    const s = io(URL, { forceNew: true });
    s.on('connect', () => s.emit('login', { userCode }));
    s.once('loginSuccess', () => resolve(s));
    s.once('loginError', msg => { log(userCode, '로그인 실패: ' + msg); resolve(null); });
    setTimeout(() => resolve(null), 3000);
  });
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

function waitEvent(sock, event, timeoutMs = 4000) {
  return new Promise(resolve => {
    const t = setTimeout(() => resolve(null), timeoutMs);
    sock.once(event, (data) => { clearTimeout(t); resolve(data ?? true); });
  });
}

async function ensureUser(admin, userCode, userName) {
  await new Promise(resolve => {
    admin.emit('adminGetUsers');
    admin.once('adminUsers', users => {
      if (users.find(u => u.userCode === userCode)) { resolve(); return; }
      admin.emit('adminSaveUser', { userCode, userName, isAdmin: false });
      admin.once('adminUsers', () => resolve());
    });
  });
}

async function run() {
  console.log('\n=== 훌라 다중 방(room) 시스템 테스트 ===\n');

  const admin = await connectAndLogin('kkkyyy123');
  ok('관리자 로그인', !!admin);
  if (!admin) { summary(); return; }

  await new Promise(resolve => {
    admin.emit('adminLogin', { password: 'dd291234' });
    admin.once('adminLoginResult', ({ ok: o }) => { ok('관리자 권한', o); resolve(); });
  });

  await ensureUser(admin, 'testuser1', '테스트유저1');
  await ensureUser(admin, 'testuser2', '테스트유저2');
  await ensureUser(admin, 'testuser3', '테스트유저3');

  await new Promise(resolve => {
    admin.emit('adminSetEntryCode', { code: '1234' });
    admin.once('adminSetEntryCodeResult', resolve);
    setTimeout(resolve, 1000);
  });

  const u1 = await connectAndLogin('testuser1');
  const u2 = await connectAndLogin('testuser2');
  const u3 = await connectAndLogin('testuser3');
  ok('테스트유저1 로그인', !!u1);
  ok('테스트유저2 로그인', !!u2);
  ok('테스트유저3 로그인', !!u3);
  if (!u1 || !u2 || !u3) { cleanup([admin, u1, u2, u3]); return; }

  // 실제 클라이언트처럼 "접속중" 표시 켜기 (초대 대상 온라인 체크에 필요)
  for (const s of [admin, u1, u2, u3]) s.emit('presenceVisible');
  await wait(200);

  // 입장 코드 게이트 통과 (로비 진입, 특정 방엔 안 들어감)
  for (const [name, s] of [['admin', admin], ['u1', u1], ['u2', u2], ['u3', u3]]) {
    s.emit('joinMulti', { entryCode: '1234' });
  }
  const [aOk, u1Ok, u2Ok, u3Ok] = await Promise.all([
    waitEvent(admin, 'joinMultiOk'), waitEvent(u1, 'joinMultiOk'), waitEvent(u2, 'joinMultiOk'), waitEvent(u3, 'joinMultiOk'),
  ]);
  ok('전원 로비 입장 (joinMultiOk, roomId=null)', aOk?.roomId === null && u1Ok?.roomId === null && u2Ok?.roomId === null && u3Ok?.roomId === null);

  // ── 방1: admin이 만들고 testuser1을 초대 ──────────────────────────
  admin.emit('createRoom', { title: '방1', code: '', inviteTargets: ['testuser1'] });
  const room1Created = await waitEvent(admin, 'createRoomOk');
  ok('방1 생성', !!room1Created);
  const room1Id = room1Created?.roomId;

  const invReceived = await waitEvent(u1, 'inviteReceived');
  ok('testuser1이 초대 받음', !!invReceived && invReceived.fromCode === 'kkkyyy123');

  u1.emit('respondInvite', { accept: true, fromCode: 'kkkyyy123' });
  const inviteAccepted = await waitEvent(u1, 'inviteAccepted');
  ok('초대 수락 처리됨', !!inviteAccepted);
  u1.emit('joinRoomViaInvite');
  const u1Joined = await waitEvent(u1, 'joinMultiOk');
  ok('testuser1이 방1에 자동 입장', u1Joined?.roomId === room1Id);

  // ── 방2: testuser2가 코드("9999") 걸어서 생성 (초대 없음) ────────────
  u2.emit('createRoom', { title: '방2', code: '9999' });
  const room2Created = await waitEvent(u2, 'createRoomOk');
  ok('방2 생성 (코드 있음)', !!room2Created);
  const room2Id = room2Created?.roomId;

  await wait(300);

  // ── 방 목록 확인 (testuser3 관점) ─────────────────────────────────
  u3.emit('listRooms');
  const roomList = await waitEvent(u3, 'roomList');
  const r1 = roomList?.rooms.find(r => r.id === room1Id);
  const r2 = roomList?.rooms.find(r => r.id === room2Id);
  ok('방 목록에 방1(잠금없음, 2명)', r1 && r1.locked === false && r1.memberCount === 2);
  ok('방 목록에 방2(잠금, 1명)', r2 && r2.locked === true && r2.memberCount === 1);

  // ── testuser3, 방2를 코드 없이 시도 → 코드 요청 받아야 함 ─────────
  u3.emit('joinRoomByList', { roomId: room2Id });
  const needsCode = await waitEvent(u3, 'joinRoomNeedsCode');
  ok('코드 없이 잠긴 방 입장 시 코드 요청', !!needsCode);

  // 틀린 코드
  u3.emit('joinRoomByList', { roomId: room2Id, code: '0000' });
  const wrongCode = await waitEvent(u3, 'joinRoomNeedsCode');
  ok('틀린 코드 재요청', !!wrongCode);

  // 맞는 코드
  u3.emit('joinRoomByList', { roomId: room2Id, code: '9999' });
  const u3Joined = await waitEvent(u3, 'joinMultiOk');
  ok('맞는 코드로 방2 입장', u3Joined?.roomId === room2Id);

  await wait(300);

  // ── 두 방에서 동시에 게임 시작 (각각 2명, AI 2명씩 채워짐) ────────
  // 방1 방장=admin, 방2 방장=u2 → 비방장(u1/u3)이 먼저 준비, 방장이 시작
  u1.emit('markRoomReady');
  u3.emit('markRoomReady');
  await wait(300);
  admin.emit('startRoomGame'); // 방1: 방장(admin)이 시작
  u2.emit('startRoomGame');    // 방2: 방장(u2)이 시작

  const [g1Admin, g1U1, g2U2, g2U3] = await Promise.all([
    waitEvent(admin, 'gameState', 6000), waitEvent(u1, 'gameState', 6000),
    waitEvent(u2, 'gameState', 6000), waitEvent(u3, 'gameState', 6000),
  ]);
  ok('방1 admin gameState 수신', !!g1Admin);
  ok('방1 testuser1 gameState 수신', !!g1U1);
  ok('방2 testuser2 gameState 수신', !!g2U2);
  ok('방2 testuser3 gameState 수신', !!g2U3);
  ok('방1/방2 게임 ID 서로 다름 (독립적인 동시 게임)', g1Admin && g2U2 && g1Admin.id !== g2U2.id);
  ok('방1 게임 같은 game_id 공유(admin=u1)', g1Admin?.id === g1U1?.id);
  ok('방2 게임 같은 game_id 공유(u2=u3)', g2U2?.id === g2U3?.id);
  ok('방1 4명(2인간+AI2) 구성', g1Admin?.players?.length === 4);
  ok('방2 4명(2인간+AI2) 구성', g2U2?.players?.length === 4);

  console.log('\n--- 두 방 동시 진행 10초 관찰 ---');
  let errorCount = 0;
  for (const [name, s] of [['admin', admin], ['u1', u1], ['u2', u2], ['u3', u3]]) {
    s.on('actionError', msg => { errorCount++; log(name, 'actionError: ' + msg); });
  }
  await wait(10000);
  ok('actionError 없음 (두 방 서로 안 섞임)', errorCount === 0);

  cleanup([admin, u1, u2, u3]);
}

function cleanup(socks) {
  socks.forEach(s => s?.disconnect());
  summary();
}

function summary() {
  console.log(`\n=== 결과: ✅ ${passed}개 통과 / ❌ ${failed}개 실패 ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch(e => { console.error('에러:', e); process.exit(1); });
