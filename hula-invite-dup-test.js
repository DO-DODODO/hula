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
function once(sock, event, timeoutMs = 4000) {
  return new Promise(resolve => {
    const t = setTimeout(() => resolve(null), timeoutMs);
    sock.once(event, (data) => { clearTimeout(t); resolve(data ?? true); });
  });
}

async function main() {
  console.log('\n=== 이슈3: 중복 로그인(페이지 이동) 후 초대가 영구히 막히는지 검증 ===\n');
  const X = await connectAndLogin('dd');
  const Y1 = await connectAndLogin('downey');

  // X가 방을 만들고 Y를 초대 (createRoom의 inviteTargets 사용)
  X.emit('createRoom', { title: '초대테스트방', inviteTargets: ['downey'] });
  const created = await once(X, 'createRoomOk');
  log('X', `방 생성: ${JSON.stringify(created)}`);
  const invited1 = await once(Y1, 'inviteReceived');
  log('Y1', `초대 수신 여부: ${!!invited1}`);

  // Y가 "페이지 이동"하듯 같은 계정으로 새 소켓을 열어 재로그인 (기존 소켓은 그대로 살아있는 상태에서)
  console.log('\n--- Y가 페이지 이동하듯 새 소켓으로 재로그인 (기존 소켓 강제종료 유발) ---');
  const Y2 = io(URL, { transports: ['websocket'], forceNew: true });
  await new Promise(resolve => {
    Y2.on('connect', () => { Y2.emit('presenceVisible'); Y2.emit('login', { userCode: 'downey' }); });
    Y2.once('loginSuccess', () => { Y2.emit('presenceVisible'); resolve(); });
  });
  log('Y2', '재로그인 완료 (Y1은 강제 종료됐어야 함)');
  await wait(500);

  // X가 응답을 기다리다 취소하고, 새 방을 만들어서 Y에게 다시 초대 시도
  X.emit('cancelInvite');
  await wait(300);

  X.emit('createRoom', { title: '두번째방' });
  const created2 = await once(X, 'createRoomOk');
  X.emit('inviteToRoom', { targetUserCode: 'downey' });
  const inviteResult = await Promise.race([
    once(X, 'inviteSent').then(d => ({ ok: true, d })),
    once(X, 'inviteError').then(d => ({ ok: false, d })),
  ]);
  console.log('\n=== 결과 ===');
  console.log('두번째 방에서 다시 초대 시도:', JSON.stringify(inviteResult));
  if (inviteResult.ok) console.log('✅ 정상 — 이전 초대가 남아있지 않고 새 초대가 성공함');
  else console.log('❌ 여전히 막힘 — pendingInvites가 정리 안 됨:', inviteResult.d);

  [X, Y1, Y2].forEach(s => s?.connected && s.disconnect());
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
