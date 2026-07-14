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

// ── 뱃지(👑싱글1위/💎멀티1위) & 훌라왕 골드 텍스트 ─────────────────────────
function badgeIcons(p) {
  return (p.isRank1Single ? '👑' : '') + (p.isRank1Multi ? '💎' : '');
}
function nameWithBadges(p, name) {
  const n = name ?? p.userName ?? '';
  const nameHtml = p.isHulaKing ? `<span class="name-gold">${n}</span>` : n;
  const icons = badgeIcons(p);
  return icons ? `${icons} ${nameHtml}` : nameHtml;
}

document.getElementById('login-hula-logo')?.classList.add('play');

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
  if (sessionStorage.getItem('autoJoinWaiting') === '1') {
    sessionStorage.removeItem('autoJoinWaiting');
    socket.emit('joinWaitingViaInvite');
  }
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

socket.on('connect', () => {
  document.getElementById('network-banner')?.classList.remove('show');
  if (savedCode && me) socket.emit('login', { userCode: savedCode });
});
socket.on('disconnect', () => {
  document.getElementById('network-banner')?.classList.add('show');
});

function updateMainScreen() {
  document.getElementById('main-username').innerHTML = nameWithBadges(me);
  document.getElementById('single-balance').textContent = `${me.singlePoints?.toLocaleString()}점 보유`;
  document.getElementById('multi-balance').textContent = `₩${me.multiBalance?.toLocaleString()} 보유`;
  const avatarEl = document.getElementById('main-avatar');
  if (avatarEl) avatarEl.textContent = (AVATARS.find(a => a.key === me.avatar) || AVATARS[0]).emoji;
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
    `<div class="waiting-player">${nameWithBadges(p)}${p.isAdmin ? ' (관리자)' : ''}</div>`
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
  { key: 'chick',  emoji: '🐤' },
  { key: 'monkey', emoji: '🐵' },
  { key: 'turtle', emoji: '🐢' },
  { key: 'dolphin',emoji: '🐬' },
  { key: 'seal',   emoji: '🦭' },
  { key: 'sheep',  emoji: '🐑' },
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
  document.getElementById('single-points-display').textContent = `${me.singlePoints?.toLocaleString()}점`;
  document.getElementById('multi-balance-display').textContent = `₩${me.multiBalance?.toLocaleString()}`;
  document.getElementById('input-show-online').checked = me.showOnline !== false;
  document.getElementById('settings-avatar-big').textContent = (AVATARS.find(a => a.key === me.avatar) || AVATARS[0]).emoji;
  document.getElementById('settings-profile-name').innerHTML = nameWithBadges(me);
  renderAvatarGrid(me.avatar || 'person');
  if (isAdmin) {
    document.getElementById('admin-settings').style.display = '';
    document.getElementById('admin-login-area').style.display = 'none';
  }
  showScreen('screen-settings');
};
document.getElementById('btn-back-settings').onclick = () => showScreen('screen-main');

function toast(msg) {
  const t = document.createElement('div');
  t.textContent = msg;
  Object.assign(t.style, {
    position: 'fixed', bottom: '24px', left: '50%', transform: 'translateX(-50%)',
    background: '#1e1e1e', color: '#fff', padding: '10px 16px', borderRadius: '8px',
    fontSize: '13px', zIndex: '3000', boxShadow: '0 8px 20px rgba(0,0,0,0.5)',
    maxWidth: '80vw', textAlign: 'center', border: '1px solid rgba(62,207,114,0.4)'
  });
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}

document.getElementById('btn-save-message').onclick = () => {
  const msg = document.getElementById('input-win-message').value.trim().slice(0, 20);
  socket.emit('setWinMessage', { message: msg || '오예!' });
};
socket.on('winMessageSaved', () => {
  me.winMessage = document.getElementById('input-win-message').value.trim() || '오예!';
  toast('✓ 저장되었습니다');
});

socket.on('avatarSaved', ({ avatar }) => {
  me.avatar = avatar;
  const emoji = (AVATARS.find(a => a.key === avatar) || AVATARS[0]).emoji;
  const mainAvatarEl = document.getElementById('main-avatar');
  if (mainAvatarEl) mainAvatarEl.textContent = emoji;
  const bigAvatarEl = document.getElementById('settings-avatar-big');
  if (bigAvatarEl) bigAvatarEl.textContent = emoji;
});

document.getElementById('input-show-online').onchange = (e) => {
  socket.emit('setShowOnline', { show: e.target.checked });
};
socket.on('showOnlineSaved', ({ show }) => {
  me.showOnline = show;
});

document.getElementById('btn-charge-single').onclick = () => socket.emit('charge', { mode: 'single' });
document.getElementById('btn-charge-multi').onclick = () => socket.emit('charge', { mode: 'multi' });
socket.on('chargeResult', (res) => {
  if (res.ok) {
    me.singlePoints = res.singlePoints;
    me.multiBalance = res.multiBalance;
    document.getElementById('single-points-display').textContent = `${res.singlePoints?.toLocaleString()}점`;
    document.getElementById('multi-balance-display').textContent = `₩${res.multiBalance?.toLocaleString()}`;
    document.getElementById('settings-msg').textContent = `+${res.amount?.toLocaleString()} 충전 완료!`;
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
const RANKING_MODES = ['single', 'multi', 'hula'];
let activeRankingMode = 'single';
document.getElementById('btn-ranking').onclick = () => {
  socket.emit('getRanking');
  setRankingTab('single');
  showScreen('screen-ranking');
};
document.getElementById('btn-back-ranking').onclick = () => showScreen('screen-main');
function setRankingTab(mode) {
  activeRankingMode = mode;
  for (const m of RANKING_MODES) {
    document.getElementById(`tab-${m}`).classList.toggle('active', m === mode);
  }
  renderRanking(mode);
}
document.getElementById('tab-single').onclick = () => setRankingTab('single');
document.getElementById('tab-multi').onclick = () => setRankingTab('multi');
document.getElementById('tab-hula').onclick = () => setRankingTab('hula');
socket.on('ranking', (data) => {
  rankingData = data;
  renderRanking('single');
});
socket.on('presenceList', ({ online }) => {
  if (!rankingData) return;
  const set = new Set(online);
  for (const mode of RANKING_MODES) {
    for (const r of rankingData[mode] || []) r.online = set.has(r.userCode);
  }
  renderRanking(activeRankingMode);
});
function tryInvite(userCode, userName) {
  if (window.presencePending) { alert('이미 대기 중인 초대가 있어요'); return; }
  if (!confirm(`${userName}님을 멀티모드에 초대하시겠습니까?`)) return;
  socket.emit('sendInvite', { targetUserCode: userCode });
}
function winRate(wins, games) {
  if (!games) return '-';
  return Math.round((wins / games) * 100).toLocaleString() + '%';
}

function renderRanking(mode) {
  if (!rankingData) return;
  const rows = rankingData[mode] || [];
  const list = document.getElementById('ranking-list');
  if (rows.length === 0) { list.innerHTML = '<p style="color:#aaa;text-align:center;padding:16px">데이터 없음</p>'; return; }

  if (mode === 'hula') {
    let displayRank = 0;
    list.innerHTML = rows.map((r, i) => {
      if (i === 0 || r.hulaWins !== rows[i - 1].hulaWins) displayRank = i + 1;
      const avatarEmoji = (AVATARS.find(a => a.key === r.avatar) || AVATARS[0]).emoji;
      const isRank1 = displayRank === 1;
      const isMe = me && r.userCode === me.userCode;
      const rankInner = isRank1 ? '<div class="rank-logo">훌라</div>' : `<div class="prank">${displayRank}</div>`;
      const pname = isRank1 ? `<span class="pname name-gold">${r.userName}</span>` : `<span class="pname">${r.userName}</span>`;
      return `<div class="prow${isRank1 ? ' rank1' : ''}${isMe ? ' me' : ''}">
        ${rankInner}
        <div class="pav-wrap"><div class="pav">${avatarEmoji}</div></div>
        <div class="pbody">
          <div class="pname-row">${pname}${isMe ? '<span class="pme-tag">나</span>' : ''}</div>
          <div class="pstat-row"><span>싱글 ${r.singleHulaWins ?? 0}회 · 멀티 ${r.multiHulaWins ?? 0}회</span></div>
        </div>
        <div class="pvalue"><div class="amt${isRank1 ? ' name-gold' : ''}">${r.hulaWins ?? 0}회</div></div>
      </div>`;
    }).join('');
    return;
  }

  list.innerHTML = rows.map((r, i) => {
    const wins = mode === 'multi' ? r.multiWins : r.singleWins;
    const games = mode === 'multi' ? r.multiGames : r.singleGames;
    const losses = (games ?? 0) - (wins ?? 0);
    const avatarEmoji = (AVATARS.find(a => a.key === r.avatar) || AVATARS[0]).emoji;
    const isRank1 = i === 0;
    const isMe = me && r.userCode === me.userCode;
    const canInvite = isAdmin && r.online && me && r.userCode !== me.userCode;
    const rowClasses = ['prow', isRank1 && 'rank1', isMe && 'me', canInvite && 'presence-clickable'].filter(Boolean).join(' ');
    const rankLabel = isRank1 ? (mode === 'multi' ? '💎' : '👑') : String(i + 1);
    const amount = mode === 'multi' ? '₩' + r.multiBalance?.toLocaleString() : (r.singlePoints ?? 0).toLocaleString() + '점';
    const pname = `<span class="pname">${r.userName}</span>`;
    return `<div class="${rowClasses}"${canInvite ? ` data-usercode="${r.userCode}" data-username="${r.userName}"` : ''}>
      <div class="prank">${rankLabel}</div>
      <div class="pav-wrap">
        <div class="pav">${avatarEmoji}</div>
        <div class="presence-dot${r.online ? ' on' : ''}"></div>
      </div>
      <div class="pbody">
        <div class="pname-row">${pname}${isMe ? '<span class="pme-tag">나</span>' : ''}</div>
        <div class="pstat-row"><span>${(wins ?? 0).toLocaleString()}승 ${losses.toLocaleString()}패</span></div>
      </div>
      <div class="pvalue"><div class="amt">${amount}</div><div class="rate">${winRate(wins ?? 0, games ?? 0)}</div></div>
    </div>`;
  }).join('');
  list.querySelectorAll('[data-usercode]').forEach(row => {
    row.onclick = () => tryInvite(row.dataset.usercode, row.dataset.username);
  });
}

// ── Help ───────────────────────────────────────────────────────────────
document.getElementById('btn-help').onclick = () => showScreen('screen-help');
document.getElementById('btn-back-help').onclick = () => showScreen('screen-main');
