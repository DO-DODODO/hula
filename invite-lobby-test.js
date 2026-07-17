const { io } = require('socket.io-client');
const URL = 'http://localhost:3000';
function log(who, msg) { console.log(`[${who}] ${msg}`); }
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
function connectAndLogin(userCode) {
  return new Promise(resolve => {
    const s = io(URL, { forceNew: true });
    s.on('connect', () => s.emit('login', { userCode }));
    s.once('loginSuccess', () => resolve(s));
    s.once('loginError', () => resolve(null));
    setTimeout(() => resolve(null), 3000);
  });
}
function waitEvent(sock, event, timeoutMs = 4000) {
  return new Promise(resolve => {
    const t = setTimeout(() => resolve(null), timeoutMs);
    sock.once(event, (data) => { clearTimeout(t); resolve(data ?? true); });
  });
}

async function run() {
  const a = await connectAndLogin('kkkyyy123');
  const b = await connectAndLogin('testuser1');
  for (const s of [a, b]) s.emit('presenceVisible');
  await wait(200);

  // B: 로비(방 목록)까지만 진입, 어떤 방에도 안 들어감
  b.emit('joinMulti');
  const bLobby = await waitEvent(b, 'joinMultiOk');
  log('B', `로비 진입: ${JSON.stringify(bLobby)} (roomId는 null이어야 정상)`);

  // A: 방 만들면서 B 초대
  a.emit('joinMulti');
  await waitEvent(a, 'joinMultiOk');
  b.on('inviteError', msg => log('B', `❗ inviteError: ${msg}`));
  a.on('inviteError', msg => log('A', `❗ inviteError: ${msg}`));

  a.emit('createRoom', { title: '로비초대테스트', code: '', inviteTargets: ['testuser1'] });
  const createRes = await waitEvent(a, 'createRoomOk');
  log('A', `방 생성: ${JSON.stringify(createRes)}`);

  const invited = await waitEvent(b, 'inviteReceived', 5000);
  if (invited) {
    console.log('✅ 로비에 있던 B가 정상적으로 초대 받음:', JSON.stringify(invited));
  } else {
    console.log('❌ B가 초대를 못 받음 (inviteError를 확인하세요)');
  }

  a.disconnect(); b.disconnect();
  process.exit(invited ? 0 : 1);
}
run().catch(e => { console.error(e); process.exit(1); });
