const { io } = require('socket.io-client');

const URL = 'http://localhost:3000';
const log = (who, msg) => console.log(`[${who}] ${msg}`);
let passed = 0, failed = 0;
function ok(label, cond) { if (cond) { console.log(`  ✅ ${label}`); passed++; } else { console.log(`  ❌ ${label}`); failed++; } }

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

async function run() {
  console.log('\n=== 훌라 추가 테스트 (방나가기/싱글모드) ===\n');

  const admin = await connectAndLogin('kkkyyy123');
  const u1 = await connectAndLogin('testuser1');
  const u2 = await connectAndLogin('testuser2');
  ok('로그인 3명', !!admin && !!u1 && !!u2);
  for (const s of [admin, u1, u2]) s.emit('presenceVisible');
  await wait(200);

  // ── 1. 싱글모드는 방 시스템과 무관하게 정상 동작해야 함 ──────────────
  u1.emit('startSingle', {});
  const singleState = await waitEvent(u1, 'gameState');
  ok('싱글모드 게임 시작됨', !!singleState && singleState.mode === 'single');
  ok('싱글모드 4명(본인+AI3)', singleState?.players?.length === 4);
  u1.emit('adminStopGame'); // 비관리자의 싱글 중단 경로
  const stopped = await waitEvent(u1, 'gameStopped');
  ok('싱글모드 중단 가능(비관리자)', !!stopped);

  // ── 2. 방 만들면서 초대: admin이 testuser2를 초대 (코드 없음) ─────────────
  admin.emit('createRoom', { title: '테스트초대방', code: '', inviteTargets: ['testuser2'] });
  const quickCreated = await waitEvent(admin, 'createRoomOk');
  ok('방 생성', !!quickCreated);
  const quickRoomId = quickCreated?.roomId;

  const invReceived = await waitEvent(u2, 'inviteReceived');
  ok('testuser2가 초대 받음(코드 몰라도 됨)', !!invReceived);

  admin.emit('listRooms');
  const list = await waitEvent(admin, 'roomList');
  const qroom = list?.rooms.find(r => r.id === quickRoomId);
  ok('생성된 방은 코드 없음(잠금 안됨)', qroom && qroom.locked === false);

  u2.emit('respondInvite', { accept: true, fromCode: 'kkkyyy123' });
  await waitEvent(u2, 'inviteAccepted');
  u2.emit('joinRoomViaInvite');
  const u2Joined = await waitEvent(u2, 'joinMultiOk');
  ok('testuser2가 코드 없이 바로 입장', u2Joined?.roomId === quickRoomId);

  // ── 3. 게임 시작 전 방 나가기: 2명 중 1명이 나가면 1명만 남으므로 방 자체가 삭제됨 ──
  const adminClosed = waitEvent(admin, 'roomClosed');
  u2.emit('leaveRoom');
  const closedMsg = await adminClosed;
  ok('2명 중 1명 나가면 남은 admin도 roomClosed 알림 받음', !!closedMsg);

  admin.emit('listRooms');
  const list2 = await waitEvent(admin, 'roomList');
  const qroomAfterLeave = list2?.rooms.find(r => r.id === quickRoomId);
  ok('나간 뒤 방 자체가 목록에서 사라짐', !qroomAfterLeave);

  cleanup([admin, u1, u2]);
}

function cleanup(socks) { socks.forEach(s => s?.disconnect()); summary(); }
function summary() {
  console.log(`\n=== 결과: ✅ ${passed}개 통과 / ❌ ${failed}개 실패 ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}
run().catch(e => { console.error('에러:', e); process.exit(1); });
