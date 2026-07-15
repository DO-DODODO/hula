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
  const rate = Math.floor((wins / games) * 1000) / 10;
  return rate.toFixed(1) + '%';
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

// ── My Stats ───────────────────────────────────────────────────────────
let mystatsScope = 'me';
let mystatsMode = 'single';
let mystatsPeriod = 'month';
let mystatsMetric = 'value';
let mystatsData = null;

document.getElementById('btn-mystats').onclick = () => {
  mystatsScope = 'me'; mystatsMode = 'single'; mystatsPeriod = 'month'; mystatsMetric = 'value';
  msSyncTabs();
  msFetch();
  showScreen('screen-mystats');
};
document.getElementById('btn-back-mystats').onclick = () => showScreen('screen-main');
document.getElementById('mystats-tab-me').onclick = () => { mystatsScope = 'me'; msSyncTabs(); msFetch(); };
document.getElementById('mystats-tab-all').onclick = () => { mystatsScope = 'all'; msSyncTabs(); msFetch(); };
document.getElementById('mystats-mode-single').onclick = () => { mystatsMode = 'single'; msSyncTabs(); msFetch(); };
document.getElementById('mystats-mode-multi').onclick = () => { mystatsMode = 'multi'; msSyncTabs(); msFetch(); };

function msSyncTabs() {
  document.getElementById('mystats-tab-me').classList.toggle('active', mystatsScope === 'me');
  document.getElementById('mystats-tab-all').classList.toggle('active', mystatsScope === 'all');
  document.getElementById('mystats-mode-single').classList.toggle('active', mystatsMode === 'single');
  document.getElementById('mystats-mode-multi').classList.toggle('active', mystatsMode === 'multi');
}

function msFetch() {
  document.getElementById('mystats-content').innerHTML = '<p class="ms-empty-msg">불러오는 중...</p>';
  socket.emit('getMyStats', { mode: mystatsMode, scope: mystatsScope, period: mystatsPeriod });
}

function msSetPeriod(period) {
  mystatsPeriod = period;
  msFetch();
}

function msToggleMetric() {
  mystatsMetric = mystatsMetric === 'value' ? 'winrate' : 'value';
  renderMyStats();
}

socket.on('myStats', (data) => {
  mystatsData = data;
  renderMyStats();
});

const MS_WEEKDAY_KR = ['일', '월', '화', '수', '목', '금', '토'];
function msFormatCardDate(unixSec) {
  if (unixSec == null) return '-';
  const d = new Date(unixSec * 1000);
  return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()} (${MS_WEEKDAY_KR[d.getDay()]})`;
}
function msFormatAxisDate(dateKey) {
  if (!dateKey) return '';
  const [, m, d] = dateKey.split('-');
  return `${parseInt(m, 10)}/${parseInt(d, 10)}`;
}
function msFormatValue(v, mode, metric) {
  if (v === null || v === undefined || Number.isNaN(v)) return '-';
  if (metric === 'winrate') return v.toFixed(1) + '%';
  return mode === 'multi' ? '₩' + Math.round(v).toLocaleString() : Math.round(v).toLocaleString() + '점';
}
function msFormatSigned(v, mode) {
  if (v === null || v === undefined) return '-';
  const abs = Math.abs(v);
  const sign = v >= 0 ? '+' : '-';
  return mode === 'multi' ? `${sign}₩${abs.toLocaleString()}` : `${sign}${abs.toLocaleString()}점`;
}
function msAvatarEmoji(avatar) {
  return (AVATARS.find(a => a.key === avatar) || AVATARS[0]).emoji;
}

function msPointsFor(values, min, max) {
  const n = values.length;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const v = values[i];
    if (v === null || v === undefined) continue;
    const x = n <= 1 ? 0 : (i / (n - 1)) * 300;
    const y = max === min ? 50 : 100 - ((v - min) / (max - min)) * 100;
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return pts;
}
function msPolyline(values, min, max, color, width) {
  const pts = msPointsFor(values, min, max);
  if (pts.length === 0) return '';
  let html = `<polyline points="${pts.join(' ')}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round"/>`;
  const last = pts[pts.length - 1].split(',');
  html += `<circle cx="${last[0]}" cy="${last[1]}" r="4" fill="${color}" stroke="#134d2b" stroke-width="2"/>`;
  return html;
}

function msRenderMeCards(summary) {
  const mode = mystatsMode;
  const { maxGain, maxLoss, maxWinStreak: win, maxLoseStreak: lose } = summary;
  const cell = (label, color, body) => `<div class="ms-card"><div class="ic-lb"><span style="color:${color}">${label}</span></div>${body}</div>`;
  return (
    cell('▲ 한 판 최고 획득', '#7fd88f', maxGain
      ? `<div class="val pos">${msFormatSigned(maxGain.value, mode)}</div><div class="date">${msFormatCardDate(maxGain.playedAt)}</div>`
      : '<div class="empty">기록 없음</div>') +
    cell('▼ 한 판 최대 손실', '#e08f8f', maxLoss
      ? `<div class="val neg">${msFormatSigned(maxLoss.value, mode)}</div><div class="date">${msFormatCardDate(maxLoss.playedAt)}</div>`
      : '<div class="empty">기록 없음</div>') +
    `<div class="ms-card"><div class="ic-lb">🔥 최다 연승</div>${win.count > 0
      ? `<div class="val" style="color:var(--gold)">${win.count}연승</div><div class="date">${msFormatCardDate(win.playedAt)}</div>`
      : '<div class="empty">기록 없음</div>'}</div>` +
    `<div class="ms-card"><div class="ic-lb">💧 최다 연패</div>${lose.count > 0
      ? `<div class="val" style="color:var(--text-dim)">${lose.count}연패</div><div class="date">${msFormatCardDate(lose.playedAt)}</div>`
      : '<div class="empty">기록 없음</div>'}</div>`
  );
}

function msFormatMiniDate(unixSec) {
  if (unixSec == null) return '-';
  const d = new Date(unixSec * 1000);
  return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`;
}

// 최고 획득자/손실자: 항상 1명 (pointChange는 연속값이라 동점 드묾)
function msHolderSingle(rec, valFn) {
  return rec
    ? `<div class="holder"><span class="holder-av">${msAvatarEmoji(rec.avatar)}</span><span class="holder-name">${rec.userName}</span></div>
       ${valFn(rec)}<div class="date">${msFormatCardDate(rec.playedAt)}</div>`
    : '<div class="empty">기록 없음</div>';
}

// 최다연승자/연패자: 공동 기록이면 전부 같이 표시
function msHolderStreak(recs, color, unit) {
  if (!recs || recs.length === 0) return '<div class="empty">기록 없음</div>';
  if (recs.length === 1) {
    const r = recs[0];
    return `<div class="holder"><span class="holder-av">${msAvatarEmoji(r.avatar)}</span><span class="holder-name">${r.userName}</span></div>
      <div class="val" style="color:${color}">${r.count}${unit}</div><div class="date">${msFormatCardDate(r.playedAt)}</div>`;
  }
  const rows = recs.map(r => `<div class="holder-multi-row"><span class="holder-av">${msAvatarEmoji(r.avatar)}</span><span class="holder-name">${r.userName}</span><span class="mini-date">${msFormatMiniDate(r.playedAt)}</span></div>`).join('');
  return `<div class="tie-val" style="color:${color}">${recs[0].count}${unit}<span class="tie-tag">공동 ${recs.length}명</span></div><div class="holder-multi">${rows}</div>`;
}

function msRenderAllCards(records) {
  const mode = mystatsMode;
  return (
    `<div class="ms-card"><div class="ic-lb"><span style="color:#7fd88f">▲ 최고 획득자</span></div>${msHolderSingle(records.maxGain, r => `<div class="val pos">${msFormatSigned(r.value, mode)}</div>`)}</div>` +
    `<div class="ms-card"><div class="ic-lb"><span style="color:#e08f8f">▼ 최고 손실자</span></div>${msHolderSingle(records.maxLoss, r => `<div class="val neg">${msFormatSigned(r.value, mode)}</div>`)}</div>` +
    `<div class="ms-card"><div class="ic-lb">🔥 최다연승자</div>${msHolderStreak(records.maxWinStreak, 'var(--gold)', '연승')}</div>` +
    `<div class="ms-card"><div class="ic-lb">💧 최다연패자</div>${msHolderStreak(records.maxLoseStreak, 'var(--text-dim)', '연패')}</div>`
  );
}

const MS_RANK_COLORS = ['#e08fa0', '#6fc9b8', '#e0a05f'];

function msRenderRankLegend(d, meColor) {
  const all = [
    { isMe: true, rank: d.myRank, userName: me?.userName || '나', color: meColor },
    ...d.trend.others.map((o, i) => ({ isMe: false, rank: o.rank, userName: o.userName, color: MS_RANK_COLORS[i % MS_RANK_COLORS.length] })),
  ];
  all.sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));
  const badge = rank => rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : (rank ?? '-');
  const items = all.map(item => `<div class="ms-rlg-item${item.isMe ? ' me' : ''}">
    <span class="badge">${badge(item.rank)}</span>
    <span class="swatch" style="background:${item.color}"></span>
    ${item.userName}${item.isMe ? '<span class="nm-tag">나</span>' : ''}
  </div>`).join('');
  return `<div class="ms-rank-legend">${items}</div>`;
}

function renderMyStats() {
  const el = document.getElementById('mystats-content');
  const d = mystatsData;
  if (!d || d.scope !== mystatsScope || d.mode !== mystatsMode || d.period !== mystatsPeriod) return;

  const mode = mystatsMode;
  const meColor = mode === 'multi' ? '#8fb8e0' : 'var(--gold)';
  const cardsHtml = d.scope === 'me' ? msRenderMeCards(d.summary) : msRenderAllCards(d.records);

  const meValues = mystatsMetric === 'value'
    ? (d.scope === 'me' ? d.trend.cumulative : d.trend.me.cumulative)
    : (d.scope === 'me' ? d.trend.winRate : d.trend.me.winRate);

  const series = [{ values: meValues, color: meColor, width: d.scope === 'all' ? 3 : 2.4 }];
  if (d.scope === 'all') {
    d.trend.others.forEach((o, i) => {
      const v = mystatsMetric === 'value' ? o.cumulative : o.winRate;
      series.push({ values: v, color: MS_RANK_COLORS[i % MS_RANK_COLORS.length], width: 2.1 });
    });
  }

  const nonNull = series.flatMap(s => s.values.filter(v => v !== null && v !== undefined));
  let min = 0, max = 1;
  if (nonNull.length) {
    min = Math.min(...nonNull); max = Math.max(...nonNull);
    if (min === max) { min -= 1; max += 1; }
    const pad = (max - min) * 0.1;
    min -= pad; max += pad;
    if (mystatsMetric === 'winrate') { min = Math.max(0, min); max = Math.min(100, max); }
  } else if (mystatsMetric === 'winrate') {
    min = 0; max = 100;
  }

  // scope=all일 땐 "나" 라인을 맨 마지막(맨 위)에 그려서 다른 라인에 안 가리게
  const drawOrder = d.scope === 'all' ? [...series.slice(1), series[0]] : series;
  const svgLines = drawOrder.map(s => msPolyline(s.values, min, max, s.color, s.width)).join('');

  let baselineHtml = '';
  if (mystatsMetric === 'winrate' && max > 50 && min < 50) {
    const y = (100 - ((50 - min) / (max - min)) * 100).toFixed(1);
    baselineHtml = `<line x1="0" y1="${y}" x2="300" y2="${y}" stroke="rgba(255,255,255,0.18)" stroke-width="1" stroke-dasharray="3,4"/>`;
  }

  const dates = d.trend.dates;
  const xAxisHtml = `<div class="ms-x-axis"><span>${msFormatAxisDate(dates[0])}</span><span>${msFormatAxisDate(dates[Math.floor(dates.length / 2)])}</span><span>오늘</span></div>`;

  const metricLabel = mystatsMetric === 'value' ? (mode === 'multi' ? '잔액 추이' : '포인트 추이') : '승률 추이';
  const periodLabel = mystatsPeriod === 'week' ? '최근 1주' : mystatsPeriod === 'month' ? '최근 1달' : '전체';
  const nowValue = meValues.length ? meValues[meValues.length - 1] : null;
  const headRightHtml = d.scope === 'me'
    ? `<div class="ms-chart-now" style="color:${meColor}">${msFormatValue(nowValue, mode, mystatsMetric)}</div>`
    : `<div class="ms-rank-pill">${d.myRank ? d.myRank + '위' : '순위 없음'}</div>`;
  const legendHtml = d.scope === 'all' ? msRenderRankLegend(d, meColor) : '';
  const subLabel = d.scope === 'all' ? '상위 3명 비교' : (mystatsMetric === 'winrate' ? '통산 승률' : '누적 값');

  el.innerHTML = `
    <div class="ms-stat-grid">${cardsHtml}</div>
    <div class="ms-chart-card">
      <div class="ms-chart-head">
        <div class="ms-chip" id="mystats-metric-chip">${metricLabel} <span class="care">▾</span></div>
        ${headRightHtml}
      </div>
      <div class="ms-chart-sub">${periodLabel} · ${subLabel}</div>
      <div class="ms-chart-plot">
        <div class="ms-y-axis" style="height:100px">
          <span>${msFormatValue(max, mode, mystatsMetric)}</span>
          <span>${msFormatValue((min + max) / 2, mode, mystatsMetric)}</span>
          <span>${msFormatValue(min, mode, mystatsMetric)}</span>
        </div>
        <svg viewBox="0 0 300 100" preserveAspectRatio="none" style="display:block;width:100%;height:100px;overflow:visible">${baselineHtml}${svgLines}</svg>
      </div>
      ${xAxisHtml}
      ${legendHtml}
      <div class="ms-chart-range">
        <button class="ms-range-pill${mystatsPeriod === 'week' ? ' active' : ''}" data-period="week">최근 1주</button>
        <button class="ms-range-pill${mystatsPeriod === 'month' ? ' active' : ''}" data-period="month">최근 1달</button>
        <button class="ms-range-pill${mystatsPeriod === 'all' ? ' active' : ''}" data-period="all">전체</button>
      </div>
    </div>
  `;

  document.getElementById('mystats-metric-chip').onclick = msToggleMetric;
  el.querySelectorAll('.ms-range-pill').forEach(btn => {
    btn.onclick = () => msSetPeriod(btn.dataset.period);
  });
}

// ── Help ───────────────────────────────────────────────────────────────
document.getElementById('btn-help').onclick = () => showScreen('screen-help');
document.getElementById('btn-back-help').onclick = () => showScreen('screen-main');
