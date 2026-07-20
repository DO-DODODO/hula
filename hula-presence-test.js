const { io } = require('socket.io-client');

const URL = 'http://localhost:3999';

function connectAs(userCode) {
  return new Promise((resolve) => {
    const s = io(URL, { transports: ['websocket'] });
    s.on('connect', () => {
      s.emit('presenceVisible'); // presence.js line 24 재현
      s.emit('login', { userCode });
    });
    s.on('loginSuccess', (u) => {
      s.emit('presenceVisible'); // presence.js line 25 재현
      console.log(`[${userCode}] loginSuccess`);
      resolve(s);
    });
    s.on('loginError', (msg) => {
      console.log(`[${userCode}] loginError: ${msg}`);
      resolve(null);
    });
  });
}

async function main() {
  console.log('--- dd 접속 ---');
  const dd = await connectAs('dd');

  console.log('--- 3초 대기 (dd 혼자 접속중) ---');
  await new Promise(r => setTimeout(r, 3000));

  console.log('--- downey 접속 ---');
  const downey = await connectAs('downey');

  // downey가 접속하고 나서 충분히 시간이 지난 뒤 (로그인 타이밍 레이스 다 끝난 뒤) 랭킹 요청
  for (let i = 1; i <= 5; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const result = await new Promise((resolve) => {
      dd.once('ranking', (data) => resolve(data));
      dd.emit('getRanking');
    });
    const downeyRow = (result.single || []).find(r => r.userCode === 'downey');
    console.log(`[체크 ${i}, downey 접속 후 ${i * 2}초 경과] downey.online = ${downeyRow?.online}`);
  }

  dd.disconnect();
  downey.disconnect();
  process.exit(0);
}

main();
