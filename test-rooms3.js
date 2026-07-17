const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';
let passed = 0, failed = 0;
function ok(label, cond) { if (cond) { console.log(`  ✅ ${label}`); passed++; } else { console.log(`  ❌ ${label}`); failed++; } }
function connectAndLogin(userCode) {
  return new Promise(resolve => {
    const s = io(URL, { forceNew: true });
    s.on('connect', () => s.emit('login', { userCode }));
    s.once('loginSuccess', () => resolve(s));
    s.once('loginError', msg => resolve(null));
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
  console.log('\n=== 입장코드 제거 + 방 나가기 정책 테스트 ===\n');
  const a = await connectAndLogin('kkkyyy123');
  const b = await connectAndLogin('testuser1');
  const c = await connectAndLogin('testuser2');
  for (const s of [a, b, c]) s.emit('presenceVisible');
  await wait(200);

  // ── 입장코드 없이 바로 로비 ──────────────────────────────────────────
  a.emit('joinMulti');
  const aOk = await waitEvent(a, 'joinMultiOk');
  ok('입장코드 없이 joinMulti만으로 바로 로비 진입', aOk && aOk.roomId === null);

  // ── 3명 방: a가 만들고 b,c 초대 ──────────────────────────────────────
  a.emit('createRoom', { title: '3인방', code: '', inviteTargets: ['testuser1', 'testuser2'] });
  await waitEvent(a, 'createRoomOk');
  const invB = await waitEvent(b, 'inviteReceived');
  const invC = await waitEvent(c, 'inviteReceived');
  ok('b, c 둘 다 초대 받음', !!invB && !!invC);

  b.emit('respondInvite', { accept: true, fromCode: 'kkkyyy123' });
  await waitEvent(b, 'inviteAccepted');
  b.emit('joinRoomViaInvite');
  await waitEvent(b, 'joinMultiOk');

  c.emit('respondInvite', { accept: true, fromCode: 'kkkyyy123' });
  await waitEvent(c, 'inviteAccepted');
  c.emit('joinRoomViaInvite');
  await waitEvent(c, 'joinMultiOk');
  await wait(300);

  // ── 3명 중 1명(c) 나가기 → 2명 남음 → 방 유지되어야 함 ─────────────────
  let aRoomClosed = false, bRoomClosed = false;
  a.once('roomClosed', () => { aRoomClosed = true; });
  b.once('roomClosed', () => { bRoomClosed = true; });
  c.emit('leaveRoom');
  await wait(500);
  ok('3명 중 1명 나가서 2명 남으면 방 유지 (a에 roomClosed 안 옴)', !aRoomClosed);
  ok('3명 중 1명 나가서 2명 남으면 방 유지 (b에 roomClosed 안 옴)', !bRoomClosed);

  // ── 2명 중 1명(b) 나가기 → 1명만 남음 → 방 삭제, a도 로비로 튕겨야 함 ───
  const aClosedPromise = waitEvent(a, 'roomClosed');
  b.emit('leaveRoom');
  const aClosed = await aClosedPromise;
  ok('2명 중 1명 나가서 1명만 남으면 방 삭제되고 남은 사람도 알림 받음', !!aClosed);
  console.log(`  ℹ️  안내 메시지: ${aClosed?.reason}`);

  console.log(`\n=== 결과: ✅ ${passed}개 통과 / ❌ ${failed}개 실패 ===\n`);
  [a, b, c].forEach(s => s?.disconnect());
  process.exit(failed > 0 ? 1 : 0);
}
run().catch(e => { console.error('에러:', e); process.exit(1); });
