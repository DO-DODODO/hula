const socket = io({ transports: ['websocket'] });
let me = null;
let rankingData = null;
let isAdmin = false;

// ── Cookie Helpers ─────────────────────────────────────────────────────
function setCookie(name, value, days = 365) {
  const d = new Date();
  d.setTime(d.getTime() + days * 24 * 60 * 60 * 1000);
  document.cookie = `${name}=${encodeURIComponent(value)};expires=${d.toUTCString()};path=/`;
}
function getCookie(name) {
  const v = document.cookie.match(`(?:^|; )${name}=([^;]*)`);
  return v ? decodeURIComponent(v[1]) : null;
}

// ── Screen Navigation ──────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ── Login ──────────────────────────────────────────────────────────────
document.getElementById('btn-login').onclick = () => {
  const code = document.getElementById('input-usercode').value.trim();
  if (!code) return;
  socket.emit('login', { userCode: code });
};
document.getElementById('input-usercode').onkeydown = e => { if (e.key === 'Enter') document.getElementById('btn-login').click(); };

socket.on('loginSuccess', (user) => {
  me = user;
  isAdmin = user.isAdmin;
  setCookie('userCode', user.userCode);
  setCookie('userName', user.userName);
  setCookie('isAdmin', user.isAdmin ? '1' : '0');
  updateMainScreen();
  showScreen('screen-main');
});
socket.on('loginError', (msg) => {
  showScreen('screen-login');
  document.getElementById('login-error').textContent = msg;
});

socket.on('duplicateLogin', () => {
  socket.disconnect();
  sessionStorage.setItem('kicked', '1');
  location.reload();
});

// 쿠키 자동 로그인 (킥 당한 경우 자동 로그인 생략)
const savedCode = getCookie('userCode');
const wasKicked = sessionStorage.getItem('kicked') === '1';
sessionStorage.removeItem('kicked');

if (savedCode && !wasKicked) {
  socket.emit('login', { userCode: savedCode });
} else {
  showScreen('screen-login');
}

function updateMainScreen() {
  document.getElementById('main-username').textContent = me.userName;
  document.getElementById('single-balance').textContent = `${me.singlePoints}점`;
  document.getElementById('multi-balance').textContent = `₩${me.multiBalance?.toLocaleString()}`;
}

// ── Single Mode ────────────────────────────────────────────────────────
document.getElementById('btn-single').onclick = () => {
  setCookie('gameMode', 'single');
  location.href = 'game.html';
};

// ── Multi Mode ─────────────────────────────────────────────────────────
document.getElementById('btn-multi').onclick = () => {
  showScreen('screen-multi-entry');
};
document.getElementById('btn-back-multi').onclick = () => showScreen('screen-main');
function submitEntryCode() {
  const code = document.getElementById('input-entrycode').value.trim();
  if (!code) return;
  socket.emit('joinMulti', { entryCode: code });
}
document.getElementById('btn-enter-multi').onclick = submitEntryCode;
document.getElementById('input-entrycode').onkeydown = e => { if (e.key === 'Enter') submitEntryCode(); };

let inWaitingRoom = false;
socket.on('joinMultiOk', () => {
  inWaitingRoom = true;
  showScreen('screen-waiting');
  if (isAdmin) {
    document.getElementById('admin-start-area').style.display = '';
  }
});
socket.on('joinMultiError', (msg) => {
  document.getElementById('entry-error').textContent = msg;
});

socket.on('waitingRoom', ({ players }) => {
  const el = document.getElementById('waiting-players');
  el.innerHTML = players.map(p =>
    `<div class="waiting-player">${p.userName}${p.isAdmin ? ' (관리자)' : ''}</div>`
  ).join('');
});

document.getElementById('btn-admin-start').onclick = () => {
  socket.emit('adminStartGame');
};
socket.on('adminStartError', msg => {
  document.getElementById('admin-start-error').textContent = msg;
});

socket.on('gameState', () => {
  if (!inWaitingRoom) return;
  setCookie('gameMode', 'multi');
  location.href = 'game.html';
});

document.getElementById('btn-leave-waiting').onclick = () => {
  socket.emit('leaveWaiting');
  showScreen('screen-main');
};

// ── Settings ───────────────────────────────────────────────────────────
const AVATARS = [
  { key: 'person', emoji: '👤' },
  { key: 'cat',    emoji: '🐱' },
  { key: 'bear',   emoji: '🐻' },
  { key: 'rabbit', emoji: '🐰' },
  { key: 'fox',    emoji: '🦊' },
  { key: 'frog',   emoji: '🐸' },
  { key: 'panda',  emoji: '🐼' },
  { key: 'koala',  emoji: '🐨' },
  { key: 'lion',   emoji: '🦁' },
  { key: 'hedge',  emoji: '🦔' },
  { key: 'wolf',   emoji: '🐺' },
  { key: 'raccoon',emoji: '🦝' },
  { key: 'cow',    emoji: '🐮' },
];

function renderAvatarGrid(currentAvatar) {
  const grid = document.getElementById('avatar-grid');
  if (!grid) return;
  grid.innerHTML = AVATARS.map(a => `
    <div class="avatar-item${a.key === currentAvatar ? ' selected' : ''}" data-key="${a.key}">
      ${a.emoji}
    </div>
  `).join('');
  grid.querySelectorAll('.avatar-item').forEach(el => {
    el.onclick = () => {
      grid.querySelectorAll('.avatar-item').forEach(e => e.classList.remove('selected'));
      el.classList.add('selected');
      socket.emit('setAvatar', { avatar: el.dataset.key });
    };
  });
}

document.getElementById('btn-settings').onclick = () => {
  document.getElementById('input-win-message').value = me.winMessage || '';
  document.getElementById('single-points-display').textContent = `${me.singlePoints}점`;
  document.getElementById('multi-balance-display').textContent = `₩${me.multiBalance?.toLocaleString()}`;
  renderAvatarGrid(me.avatar || 'person');
  if (isAdmin) {
    document.getElementById('admin-settings').style.display = '';
    document.getElementById('admin-login-area').style.display = 'none';
  }
  showScreen('screen-settings');
};
document.getElementById('btn-back-settings').onclick = () => showScreen('screen-main');

document.getElementById('btn-save-message').onclick = () => {
  const msg = document.getElementById('input-win-message').value.trim().slice(0, 20);
  socket.emit('setWinMessage', { message: msg || '오예!' });
};
socket.on('winMessageSaved', () => {
  me.winMessage = document.getElementById('input-win-message').value.trim() || '오예!';
  document.getElementById('settings-msg').textContent = '저장되었습니다.';
  setTimeout(() => document.getElementById('settings-msg').textContent = '', 2000);
});

socket.on('avatarSaved', ({ avatar }) => {
  me.avatar = avatar;
});

document.getElementById('btn-charge-single').onclick = () => socket.emit('charge', { mode: 'single' });
document.getElementById('btn-charge-multi').onclick = () => socket.emit('charge', { mode: 'multi' });
socket.on('chargeResult', (res) => {
  if (res.ok) {
    me.singlePoints = res.singlePoints;
    me.multiBalance = res.multiBalance;
    document.getElementById('single-points-display').textContent = `${res.singlePoints}점`;
    document.getElementById('multi-balance-display').textContent = `₩${res.multiBalance?.toLocaleString()}`;
    document.getElementById('settings-msg').textContent = `+${res.amount} 충전 완료!`;
  } else {
    document.getElementById('settings-msg').textContent = res.msg;
  }
  setTimeout(() => document.getElementById('settings-msg').textContent = '', 3000);
});

// Admin mode unlock
document.getElementById('btn-admin-mode').onclick = () => {
  document.getElementById('modal-admin-pw').style.display = 'flex';
};
document.getElementById('btn-admin-pw-cancel').onclick = () => {
  document.getElementById('modal-admin-pw').style.display = 'none';
};
document.getElementById('btn-admin-pw-ok').onclick = () => {
  const pw = document.getElementById('input-admin-pw').value;
  socket.emit('adminLogin', { password: pw });
};
socket.on('adminLoginResult', ({ ok }) => {
  if (ok) {
    isAdmin = true;
    document.getElementById('modal-admin-pw').style.display = 'none';
    document.getElementById('admin-settings').style.display = '';
    document.getElementById('admin-login-area').style.display = 'none';
    document.getElementById('admin-pw-error').textContent = '';
  } else {
    document.getElementById('admin-pw-error').textContent = '비밀번호가 틀렸습니다.';
  }
});

document.getElementById('btn-save-entry-code').onclick = () => {
  const code = document.getElementById('input-entry-code').value.trim();
  if (!code) return;
  socket.emit('adminSetEntryCode', { code });
};
socket.on('adminSetEntryCodeResult', ({ ok }) => {
  if (ok) {
    document.getElementById('settings-msg').textContent = '입장 코드 변경 완료';
    setTimeout(() => document.getElementById('settings-msg').textContent = '', 2000);
  }
});

document.getElementById('btn-manage-users').onclick = () => {
  socket.emit('adminGetUsers');
  document.getElementById('modal-users').style.display = 'flex';
};
document.getElementById('btn-close-users').onclick = () => {
  document.getElementById('modal-users').style.display = 'none';
};
document.getElementById('btn-add-user').onclick = () => {
  const code = document.getElementById('input-new-code').value.trim();
  const name = document.getElementById('input-new-name').value.trim();
  const admin = document.getElementById('input-new-admin').checked;
  if (!code || !name) return;
  socket.emit('adminSaveUser', { userCode: code, userName: name, isAdmin: admin });
};
socket.on('adminUsers', (users) => {
  const list = document.getElementById('user-list');
  list.innerHTML = users.map(u => `
    <div class="user-row">
      <span>${u.userCode}</span>
      <span>${u.userName}</span>
      ${u.isAdmin ? '<span style="color:gold">관리자</span>' : ''}
      <button onclick="deleteUser('${u.userCode}')" style="margin-left:auto;padding:2px 8px;background:#c0392b;color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:11px">삭제</button>
    </div>
  `).join('');
});
socket.on('adminSaveUserError', (msg) => {
  document.getElementById('settings-msg').textContent = msg;
  setTimeout(() => document.getElementById('settings-msg').textContent = '', 3000);
});
window.deleteUser = (code) => {
  if (confirm(`${code} 삭제?`)) socket.emit('adminDeleteUser', { userCode: code });
};

// ── Ranking ────────────────────────────────────────────────────────────
document.getElementById('btn-ranking').onclick = () => {
  socket.emit('getRanking');
  showScreen('screen-ranking');
};
document.getElementById('btn-back-ranking').onclick = () => showScreen('screen-main');
document.getElementById('tab-single').onclick = () => {
  document.getElementById('tab-single').classList.add('active');
  document.getElementById('tab-multi').classList.remove('active');
  renderRanking('single');
};
document.getElementById('tab-multi').onclick = () => {
  document.getElementById('tab-multi').classList.add('active');
  document.getElementById('tab-single').classList.remove('active');
  renderRanking('multi');
};
socket.on('ranking', (data) => {
  rankingData = data;
  renderRanking('single');
});
function renderRanking(mode) {
  if (!rankingData) return;
  const rows = rankingData[mode] || [];
  const list = document.getElementById('ranking-list');
  if (rows.length === 0) { list.innerHTML = '<p style="color:#aaa;text-align:center;padding:16px">데이터 없음</p>'; return; }
  list.innerHTML = `<table>
    <thead><tr>
      <th>순위</th><th>이름</th>
      <th>${mode === 'multi' ? '보유금액' : '포인트'}</th>
      <th>전적</th>
    </tr></thead>
    <tbody>${rows.map((r, i) => {
      const wins = mode === 'multi' ? r.multiWins : r.singleWins;
      const games = mode === 'multi' ? r.multiGames : r.singleGames;
      const losses = (games ?? 0) - (wins ?? 0);
      const avatarEmoji = (AVATARS.find(a => a.key === r.avatar) || AVATARS[0]).emoji;
      return `<tr>
        <td>${i + 1}</td>
        <td>${avatarEmoji} ${r.userName}</td>
        <td>${mode === 'multi' ? '₩' + r.multiBalance?.toLocaleString() : r.singlePoints + '점'}</td>
        <td>${wins ?? 0}승 ${losses}패</td>
      </tr>`;
    }).join('')}</tbody>
  </table>`;
}

// ── Help ───────────────────────────────────────────────────────────────
document.getElementById('btn-help').onclick = () => showScreen('screen-help');
document.getElementById('btn-back-help').onclick = () => showScreen('screen-main');
