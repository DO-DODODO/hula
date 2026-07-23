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
  socket.emit('getEventStatus'); // 메인화면 이벤트 아이콘 뱃지 표시 여부를 미리 알아야 해서 로그인 직후 조회
  if (sessionStorage.getItem('autoJoinRoom') === '1') {
    sessionStorage.removeItem('autoJoinRoom');
    socket.emit('joinRoomViaInvite');
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
  updateSkinBanner();
}

// 카드 뒷면 스킨 배너 — 배포일로부터 3일간만 노출(고정 배포일 기준, 이벤트 기능과 동일 패턴)
const CARD_SKIN_BANNER_LAUNCH = new Date('2026-07-23T00:00:00+09:00').getTime();
function updateSkinBanner() {
  const banner = document.getElementById('skin-banner');
  if (!banner) return;
  const withinWindow = Date.now() - CARD_SKIN_BANNER_LAUNCH < 3 * 86400 * 1000;
  banner.style.display = withinWindow ? '' : 'none';
}
document.getElementById('skin-banner')?.addEventListener('click', () => {
  document.getElementById('btn-settings').click();
});

// ── Single Mode ────────────────────────────────────────────────────────
document.getElementById('btn-single').onclick = () => {
  setCookie('gameMode', 'single');
  location.href = 'game.html';
};

// ── Multi Mode ─────────────────────────────────────────────────────────
document.getElementById('btn-multi').onclick = () => {
  socket.emit('joinMulti');
};

let inWaitingRoom = false;
let currentRoomId = null;

socket.on('joinMultiOk', ({ roomId } = {}) => {
  document.getElementById('room-code-error').textContent = '';
  document.getElementById('modal-room-code').style.display = 'none';
  if (!roomId) enterLobby();
  // roomId가 있으면 곧이어 오는 roomWaiting 이벤트가 화면 전환을 담당
});
socket.on('joinMultiError', (msg) => {
  toast(msg);
  document.getElementById('room-code-error').textContent = msg;
});

// 방에 있는 도중 방 자체가 없어졌을 때(누군가 나가서 인원이 부족해짐)
socket.on('roomClosed', ({ reason }) => {
  if (!inWaitingRoom) return;
  toast(reason || '방이 사라졌어요');
  enterLobby();
});

// ── 멀티 로비 (방 목록) ──────────────────────────────────────────────────
function enterLobby() {
  inWaitingRoom = false;
  currentRoomId = null;
  socket.emit('listRooms');
  socket.emit('getRanking'); // 초대 대상 목록(온라인 유저) 확보용
  showScreen('screen-multi-lobby');
}
document.getElementById('btn-back-lobby').onclick = () => showScreen('screen-main');

socket.on('roomList', ({ rooms }) => renderRoomList(rooms));
function renderRoomList(rooms) {
  const el = document.getElementById('room-list');
  if (!rooms.length) { el.innerHTML = '<div class="empty-rooms">열린 방이 없어요, 방을 만들어보세요</div>'; return; }
  el.innerHTML = rooms.map(r => {
    const isFull = r.playing ? r.waitingCap <= 0 : r.memberCount >= 4;
    const statusText = r.playing
      ? (r.waitingCap > 0 ? `게임 중 · 대기 ${r.waitingCount}/${r.waitingCap}` : '게임 중 · 정원 마감')
      : `${r.memberCount}/4`;
    return `
    <div class="room-row${isFull ? ' full' : ''}" data-roomid="${r.id}">
      <span class="lock">${r.locked ? '🔒' : ''}</span>
      <span class="rname">${r.title}</span>
      <span class="rcount">${statusText}</span>
    </div>
  `;
  }).join('');
  el.querySelectorAll('.room-row').forEach(row => {
    row.onclick = () => {
      if (row.classList.contains('full')) return;
      socket.emit('joinRoomByList', { roomId: row.dataset.roomid });
    };
  });
}

let pendingJoinRoomId = null;
socket.on('joinRoomNeedsCode', ({ roomId, title }) => {
  pendingJoinRoomId = roomId;
  document.getElementById('room-code-title').textContent = `"${title}" 코드 입력`;
  document.getElementById('input-join-room-code').value = '';
  document.getElementById('room-code-error').textContent = '';
  document.getElementById('modal-room-code').style.display = 'flex';
});
document.getElementById('btn-submit-room-code').onclick = () => {
  const code = document.getElementById('input-join-room-code').value.trim();
  socket.emit('joinRoomByList', { roomId: pendingJoinRoomId, code });
};
document.getElementById('btn-cancel-room-code').onclick = () => {
  document.getElementById('modal-room-code').style.display = 'none';
};

// ── 초대 대상 선택 (랭킹 데이터의 online 정보 재사용) ─────────────────────
function getInvitableUsers() {
  if (!rankingData) return [];
  return (rankingData.single || []).filter(r => me && r.userCode !== me.userCode && r.online);
}
function badgesForUser(userCode) {
  return {
    isRank1Single: rankingData?.single?.[0]?.userCode === userCode,
    isRank1Multi: rankingData?.multi?.[0]?.userCode === userCode,
    isHulaKing: !!(rankingData?.single || []).find(r => r.userCode === userCode)?.isHulaKing,
  };
}
function inviteRowLabel(u) {
  const avatarEmoji = (AVATARS.find(a => a.key === u.avatar) || AVATARS[0]).emoji;
  return `<span class="pav">${avatarEmoji}</span><span class="nm">${nameWithBadges(badgesForUser(u.userCode), u.userName)}</span>`;
}
// 체크박스 다중선택(최대 3명) - 방 만들기용
function renderInvitePicker(containerId) {
  const el = document.getElementById(containerId);
  const users = getInvitableUsers();
  if (!users.length) { el.innerHTML = '<div style="color:var(--text-dim);font-size:12px;padding:6px 2px">초대 가능한 접속중 유저가 없어요</div>'; return; }
  el.innerHTML = users.map(u => `
    <div class="invite-pick-row" data-usercode="${u.userCode}"><span class="chk">&nbsp;</span>${inviteRowLabel(u)}</div>
  `).join('');
  el.querySelectorAll('.invite-pick-row').forEach(row => {
    row.onclick = () => {
      const selected = el.querySelectorAll('.invite-pick-row.selected');
      const isSel = row.classList.contains('selected');
      if (!isSel && selected.length >= 3) return;
      row.classList.toggle('selected');
      const chk = row.querySelector('.chk');
      chk.classList.toggle('checked');
      chk.textContent = row.classList.contains('selected') ? '✓' : '';
    };
  });
}
// 클릭 한 번으로 즉시 초대 - 방 대기실 안에서 한 명씩 추가 초대할 때
function renderSingleInvitePicker(containerId, onPick) {
  const el = document.getElementById(containerId);
  const users = getInvitableUsers();
  if (!users.length) { el.innerHTML = '<div style="color:var(--text-dim);font-size:12px;padding:6px 2px">초대 가능한 접속중 유저가 없어요</div>'; return; }
  el.innerHTML = users.map(u => `<div class="invite-pick-row" data-usercode="${u.userCode}">${inviteRowLabel(u)}</div>`).join('');
  el.querySelectorAll('.invite-pick-row').forEach(row => { row.onclick = () => onPick(row.dataset.usercode); });
}

// ── 방 만들기 ────────────────────────────────────────────────────────────
document.getElementById('btn-open-create-room').onclick = () => {
  document.getElementById('input-room-title').value = '';
  document.getElementById('input-room-code').value = '';
  document.getElementById('create-room-error').textContent = '';
  renderInvitePicker('create-room-invite-list');
  document.getElementById('modal-create-room').style.display = 'flex';
};
document.getElementById('btn-cancel-create-room').onclick = () => {
  document.getElementById('modal-create-room').style.display = 'none';
};
document.getElementById('btn-submit-create-room').onclick = () => {
  const title = document.getElementById('input-room-title').value.trim();
  const code = document.getElementById('input-room-code').value.trim();
  const inviteTargets = [...document.querySelectorAll('#create-room-invite-list .invite-pick-row.selected')].map(r => r.dataset.usercode);
  socket.emit('createRoom', { title, code, inviteTargets });
};
socket.on('createRoomError', msg => {
  document.getElementById('create-room-error').textContent = msg;
});
socket.on('createRoomOk', () => {
  document.getElementById('modal-create-room').style.display = 'none';
});

// ── 방 대기실 ────────────────────────────────────────────────────────────
socket.on('roomWaiting', (payload) => {
  inWaitingRoom = true;
  currentRoomId = payload.id;
  const isHost = me && me.userCode === payload.hostCode;
  document.getElementById('waiting-room-title').textContent = payload.title;
  document.getElementById('waiting-room-code').textContent = payload.locked ? `코드: ${payload.code}` : '';
  document.getElementById('waiting-players').innerHTML = payload.players.map(p => {
    const hostTag = p.isHost ? '<b>(방장)</b> ' : '';
    const readyTag = !p.isHost ? (p.ready ? ' — ✅ 준비완료' : ' — ⏳ 대기중') : '';
    const kickBtn = (isHost && !p.isHost) ? `<span class="kick-x" data-usercode="${p.userCode}">✕</span>` : '';
    return `<div class="waiting-player">${hostTag}${nameWithBadges(p)}${readyTag}${kickBtn}</div>`;
  }).join('');
  document.querySelectorAll('#waiting-players .kick-x').forEach(el => {
    el.onclick = () => {
      if (confirm('이 사람을 방에서 내보낼까요?')) socket.emit('kickFromRoom', { targetUserCode: el.dataset.usercode });
    };
  });
  document.getElementById('invite-in-room-list').style.display = 'none';
  document.getElementById('room-start-error').textContent = '';
  document.getElementById('modal-create-room').style.display = 'none';
  document.getElementById('modal-room-code').style.display = 'none';

  const myReady = payload.players.find(p => p.userCode === me?.userCode)?.ready;
  document.getElementById('btn-mark-ready').style.display = (!isHost && !myReady) ? '' : 'none';
  document.getElementById('btn-start-room-game').style.display = isHost ? '' : 'none';
  document.getElementById('btn-start-room-game').disabled = isHost && !(payload.allReady && payload.players.length >= 2);
  document.getElementById('btn-invite-in-room').style.display = isHost ? '' : 'none';

  showScreen('screen-waiting');
});

document.getElementById('btn-mark-ready').onclick = () => {
  socket.emit('markRoomReady');
  document.getElementById('btn-mark-ready').style.display = 'none';
};

socket.on('kickedFromRoom', ({ roomTitle }) => {
  toast(`"${roomTitle}"에서 방장이 내보냈어요`);
  enterLobby();
});

document.getElementById('btn-invite-in-room').onclick = () => {
  const el = document.getElementById('invite-in-room-list');
  if (el.style.display !== 'none') { el.style.display = 'none'; return; }
  socket.emit('getRanking');
  renderSingleInvitePicker('invite-in-room-list', (userCode) => {
    socket.emit('inviteToRoom', { targetUserCode: userCode });
    el.style.display = 'none';
  });
  el.style.display = '';
};

document.getElementById('btn-start-room-game').onclick = () => {
  socket.emit('startRoomGame');
};
socket.on('adminStartError', msg => {
  document.getElementById('room-start-error').textContent = msg;
});

socket.on('gameState', () => {
  if (!inWaitingRoom) return;
  setCookie('gameMode', 'multi');
  location.href = 'game.html';
});

// 진행 중인 방에 대기(관전)로 들어간 경우 — 대기실을 거치지 않고 바로 게임 화면으로
socket.on('spectateOk', () => {
  setCookie('gameMode', 'multi');
  location.href = 'game.html';
});

document.getElementById('btn-leave-waiting').onclick = () => {
  socket.emit('leaveRoom');
  enterLobby();
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

// ── 카드 뒷면 스킨 ─────────────────────────────────────────────────────
// game/cardSkins.js와 동일한 정의(서버가 최종 검증하므로 클라이언트는 표시용)
const CARD_SKINS = {
  basic: { free: true, label: '기본색' },
  wine: { free: true, label: '와인색' },
  sea: { free: false, singleReq: 10000, multiReq: 1100000, label: '바다' },
  watermelon: { free: false, singleReq: 50000, multiReq: 1300000, label: '수박' },
  dolphin: { free: false, singleReq: 100000, multiReq: 1500000, label: '돌고래' },
};
const SKIN_ORDER = ['basic', 'wine', 'sea', 'watermelon', 'dolphin'];
const SKIN_THUMB_STYLE = {
  basic: 'background: linear-gradient(135deg, #1a3a6b 0%, #2d5fa6 100%);',
  wine: 'background: linear-gradient(135deg, #6b1a35 0%, #a62d5f 100%);',
  sea: "background-image:url('img/card-sea.png');background-size:cover;background-position:center;",
  watermelon: "background-image:url('img/card-watermelon.png');background-size:cover;background-position:center;",
  dolphin: "background-image:url('img/card-dolphin.png');background-size:cover;background-position:center;",
};

function renderSkinGrid() {
  const grid = document.getElementById('skin-grid');
  if (!grid) return;
  const peakSingle = me.peakSinglePoints ?? me.singlePoints ?? 0;
  const peakMulti = me.peakMultiBalance ?? me.multiBalance ?? 0;
  const selected = me.selectedCardSkin || 'basic';

  grid.innerHTML = SKIN_ORDER.map(key => {
    const cfg = CARD_SKINS[key];
    const singleMet = cfg.free || peakSingle >= (cfg.singleReq || 0);
    const multiMet = cfg.free || peakMulti >= (cfg.multiReq || 0);
    const selectable = cfg.free || singleMet || multiMet;
    const lockHtml = selectable ? '' : '<span class="lock-badge">🔒</span>';
    const statusHtml = cfg.free
      ? `<div class="skin-status ok">${key === selected ? '사용 중' : '사용 가능'}</div>`
      : `<div class="skin-status">
          <span class="cond-line ${singleMet ? 'met' : 'unmet'}">${singleMet ? '✓' : ''} 싱글 ${cfg.singleReq.toLocaleString()}P${singleMet ? '' : ' 필요'}</span>
          <span class="cond-line ${multiMet ? 'met' : 'unmet'}">${multiMet ? '✓' : ''} 멀티 ₩${cfg.multiReq.toLocaleString()}${multiMet ? '' : ' 필요'}</span>
        </div>`;
    return `<div class="skin-item">
      <div class="skin-thumb${key === selected ? ' selected' : ''}" data-skin="${key}" style="${SKIN_THUMB_STYLE[key]}">${lockHtml}</div>
      <div class="skin-name">${cfg.label}</div>
      ${statusHtml}
    </div>`;
  }).join('');

  grid.querySelectorAll('.skin-thumb').forEach(el => {
    el.onclick = () => {
      const key = el.dataset.skin;
      const cfg = CARD_SKINS[key];
      const peakSingle2 = me.peakSinglePoints ?? me.singlePoints ?? 0;
      const peakMulti2 = me.peakMultiBalance ?? me.multiBalance ?? 0;
      const selectable = cfg.free || peakSingle2 >= (cfg.singleReq || 0) || peakMulti2 >= (cfg.multiReq || 0);
      const msg = document.getElementById('skin-msg');
      if (!selectable) {
        msg.style.color = '#e08f8f';
        msg.textContent = `🔒 "${cfg.label}"은(는) 싱글 ${cfg.singleReq.toLocaleString()}P 또는 멀티 ₩${cfg.multiReq.toLocaleString()} 달성 시 선택할 수 있어요`;
        return;
      }
      socket.emit('setCardSkin', { skin: key });
    };
  });
}
socket.on('cardSkinSaved', ({ skin }) => {
  me.selectedCardSkin = skin;
  renderSkinGrid();
  const msg = document.getElementById('skin-msg');
  msg.style.color = '#7fd88f';
  msg.textContent = `"${CARD_SKINS[skin].label}"(으)로 선택했어요`;
});
socket.on('cardSkinError', (m) => {
  const msg = document.getElementById('skin-msg');
  msg.style.color = '#e08f8f';
  msg.textContent = m;
});

document.getElementById('btn-settings').onclick = () => {
  document.getElementById('input-win-message').value = me.winMessage || '';
  document.getElementById('single-points-display').textContent = `${me.singlePoints?.toLocaleString()}점`;
  document.getElementById('multi-balance-display').textContent = `₩${me.multiBalance?.toLocaleString()}`;
  document.getElementById('input-show-online').checked = me.showOnline !== false;
  document.getElementById('settings-avatar-big').textContent = (AVATARS.find(a => a.key === me.avatar) || AVATARS[0]).emoji;
  document.getElementById('settings-profile-name').innerHTML = nameWithBadges(me);
  renderAvatarGrid(me.avatar || 'person');
  renderSkinGrid();
  document.getElementById('skin-msg').textContent = '';
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
    const rowClasses = ['prow', isRank1 && 'rank1', isMe && 'me'].filter(Boolean).join(' ');
    const rankLabel = isRank1 ? (mode === 'multi' ? '💎' : '👑') : String(i + 1);
    const amount = mode === 'multi' ? '₩' + r.multiBalance?.toLocaleString() : (r.singlePoints ?? 0).toLocaleString() + '점';
    const pname = `<span class="pname">${r.userName}</span>`;
    return `<div class="${rowClasses}">
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

function msFormatDateKey(key) {
  const [, m, day] = key.split('-');
  return `${parseInt(m, 10)}.${parseInt(day, 10)}`;
}

// "나" 탭 최근 1주/1달 카드 4개 (그래프 없이 카드로만 표시)
function msRenderPeriodCards(periodTotals, mode) {
  const cell = (label, body) => `<div class="ms-card"><div class="ic-lb">${label}</div>${body}</div>`;
  const rangeText = t => `${msFormatDateKey(t.startKey)}~${msFormatDateKey(t.endKey)}`;
  const pointCard = (t, label) => {
    if (t.games === 0) return cell(label, '<div class="empty">이 기간 기록 없음</div>');
    const cls = t.pointSum >= 0 ? 'pos' : 'neg';
    return cell(label, `<div class="val ${cls}">${msFormatSigned(t.pointSum, mode)}</div><div class="date">${rangeText(t)} · ${t.games}판</div>`);
  };
  const rateCard = (t, label) => {
    if (t.games === 0) return cell(label, '<div class="empty">이 기간 기록 없음</div>');
    return cell(label, `<div class="val">${t.winRate.toFixed(1)}%</div><div class="date">${rangeText(t)} · ${t.wins}승 ${t.losses}패</div>`);
  };
  return (
    pointCard(periodTotals.week, '🗓️ 최근 1주 포인트') +
    rateCard(periodTotals.week, '🎯 최근 1주 승률') +
    pointCard(periodTotals.month, '🗓️ 최근 1달 포인트') +
    rateCard(periodTotals.month, '🎯 최근 1달 승률')
  );
}

function renderMyStats() {
  const el = document.getElementById('mystats-content');
  const d = mystatsData;
  if (!d || d.scope !== mystatsScope || d.mode !== mystatsMode) return;
  if (d.scope === 'all' && d.period !== mystatsPeriod) return;

  const mode = mystatsMode;

  // "나" 탭: 그래프 없이 역대 기록 카드 + 최근 기간 카드만 표시
  if (d.scope === 'me') {
    el.innerHTML = `
      <div class="ms-group-label">역대 기록</div>
      <div class="ms-stat-grid">${msRenderMeCards(d.summary)}</div>
      <div class="ms-group-label">최근 기간</div>
      <div class="ms-stat-grid">${msRenderPeriodCards(d.periodTotals, mode)}</div>
    `;
    return;
  }

  // "전체" 탭: 기존 그래프(상위 3명 비교) 그대로 유지
  const meColor = mode === 'multi' ? '#8fb8e0' : 'var(--gold)';
  const cardsHtml = msRenderAllCards(d.records);

  const meValues = mystatsMetric === 'value' ? d.trend.me.cumulative : d.trend.me.winRate;

  const series = [{ values: meValues, color: meColor, width: 3 }];
  d.trend.others.forEach((o, i) => {
    const v = mystatsMetric === 'value' ? o.cumulative : o.winRate;
    series.push({ values: v, color: MS_RANK_COLORS[i % MS_RANK_COLORS.length], width: 2.1 });
  });

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

  // "나" 라인을 맨 마지막(맨 위)에 그려서 다른 라인에 안 가리게
  const drawOrder = [...series.slice(1), series[0]];
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
  const headRightHtml = `<div class="ms-rank-pill">${d.myRank ? d.myRank + '위' : '순위 없음'}</div>`;
  const legendHtml = msRenderRankLegend(d, meColor);
  const subLabel = '상위 3명 비교';

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

// ── 주간 이벤트 ────────────────────────────────────────────────────────
const EVENT_CATEGORY_ORDER = ['winsSingle', 'winsMulti', 'gamesSingle', 'gamesMulti', 'hula'];
const EVENT_CATEGORY_META = {
  winsSingle: { label: '최다승 · 싱글', unit: '승', icon: '🎁' },
  winsMulti: { label: '최다승 · 멀티', unit: '승', icon: '🎁' },
  gamesSingle: { label: '최다판 · 싱글', unit: '판', icon: '🎁' },
  gamesMulti: { label: '최다판 · 멀티', unit: '판', icon: '🎁' },
  hula: { label: '최다훌라 · 합산', unit: '회', icon: '✨' },
};
let eventData = null;

// 이번 주 내가 수상했는데 아직 안 받은 게 하나라도 있으면 메인화면 이벤트 아이콘에 뱃지 표시
function updateEventBadge(data) {
  const hasUnclaimed = Object.values(data.results).some(c => c.isMine && !c.claimed);
  document.getElementById('event-badge-dot').style.display = hasUnclaimed ? '' : 'none';
}

function msFormatFullDate(unixSec) {
  const d = new Date(unixSec * 1000);
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일(${MS_WEEKDAY_KR[d.getDay()]})`;
}

document.getElementById('btn-event').onclick = () => {
  showScreen('screen-event');
  socket.emit('getEventStatus');
};
document.getElementById('btn-back-event').onclick = () => showScreen('screen-main');

document.getElementById('event-tab-live').onclick = () => evSetTab('live');
document.getElementById('event-tab-result').onclick = () => evSetTab('result');
function evSetTab(tab) {
  document.getElementById('event-tab-live').classList.toggle('active', tab === 'live');
  document.getElementById('event-tab-result').classList.toggle('active', tab === 'result');
  document.getElementById('event-panel-live').classList.toggle('active', tab === 'live');
  document.getElementById('event-panel-result').classList.toggle('active', tab === 'result');
}

socket.on('eventStatus', (data) => {
  eventData = data;
  updateEventBadge(data);

  // 이벤트 화면이 지금 안 열려있으면(로그인 직후 뱃지용 조회) 화면 갱신은 건너뜀
  if (!document.getElementById('screen-event').classList.contains('active')) return;

  document.getElementById('event-msg').textContent = '';

  document.getElementById('event-dates').textContent =
    `${msFormatCardDate(data.currentStartSec)} ~ ${msFormatCardDate(data.currentLastDaySec)}`;

  const noticeStartSec = data.currentStartSec + 7 * 86400;
  const noticeEndSec = noticeStartSec + 7 * 86400 - 1;
  document.getElementById('event-notice').innerHTML =
    `📅 이번 주 결과는 <b>${msFormatFullDate(noticeStartSec)} ~ ${msFormatFullDate(noticeEndSec)}</b>까지 이 메뉴에서 받을 수 있어요`;

  renderEventLive(data);
  renderEventResults(data);
});

function renderEventLive(data) {
  const grid = document.getElementById('event-live-grid');
  grid.innerHTML = EVENT_CATEGORY_ORDER.map(key => {
    const meta = EVENT_CATEGORY_META[key];
    const c = data.live[key];
    if (c.winners.length === 0) {
      return `<div class="live-card empty"><div class="lc-lb">${meta.label}</div><div class="lc-body">아직 없음</div></div>`;
    }
    const w = c.winners[0];
    const tie = c.winners.length > 1 ? ` 외 ${c.winners.length - 1}명` : '';
    const wide = key === 'hula' ? ' style="grid-column:1 / span 2"' : '';
    return `<div class="live-card"${wide}><div class="lc-lb">${meta.label}</div><div class="lc-body"><span class="lc-av">${msAvatarEmoji(w.avatar)}</span><span class="lc-nm">${w.userName}${tie}</span><span class="lc-val">${c.value}${meta.unit}</span></div></div>`;
  }).join('');
}

function evRewardText(c) {
  return [
    c.pointAmount ? `${c.pointAmount.toLocaleString()}점` : null,
    c.moneyAmount ? `₩${c.moneyAmount.toLocaleString()}` : null,
  ].filter(Boolean).join('+');
}

function renderEventResults(data) {
  const list = document.getElementById('event-result-list');
  document.getElementById('event-result-label').textContent =
    `지난 주 결과 (${msFormatCardDate(data.lastStartSec)} ~ ${msFormatCardDate(data.lastLastDaySec)})`;

  if (!data.resultsAvailable) {
    list.innerHTML = `<div class="result-card"><div class="rc-empty">🎉 이벤트 첫 주가 진행 중이에요 — 다음 주부터 결과가 나와요</div></div>`;
    return;
  }

  list.innerHTML = EVENT_CATEGORY_ORDER.map(key => {
    const meta = EVENT_CATEGORY_META[key];
    const c = data.results[key];
    const rewardText = evRewardText(c);

    if (c.winners.length === 0) {
      return `<div class="result-card">
        <div class="rc-top"><span class="rc-title">🥇 ${meta.label}</span><span class="rc-reward">${rewardText}</span></div>
        <div class="rc-empty">이번 주 해당자 없음</div>
      </div>`;
    }

    const winnerHtml = c.winners.map(w => {
      const isMe = me && w.userCode === me.userCode;
      return `<span class="rc-av">${msAvatarEmoji(w.avatar)}</span><span class="rc-nm">${w.userName}${isMe ? ' (나)' : ''}</span>`;
    }).join('<span class="rc-nm" style="margin-left:-2px">, </span>');
    const tieTag = c.winners.length > 1 ? `<span class="rc-tie-tag">공동 ${c.winners.length}명</span>` : '';

    let claimHtml = '';
    if (c.isMine) {
      claimHtml = c.claimed
        ? `<div class="rc-claim-row"><span class="claim-hint claimed">✓ 수령 완료</span><button class="btn-claimed" disabled>받음</button></div>`
        : `<div class="rc-claim-row"><span class="claim-hint">받을 수 있어요!</span><button class="btn-claim" data-category="${key}">받기</button></div>`;
    }

    return `<div class="result-card${c.isMine ? ' mine' : ''}">
      <div class="rc-top"><span class="rc-title">🥇 ${meta.label}</span><span class="rc-reward">${rewardText}</span></div>
      <div class="rc-winner">${winnerHtml}${tieTag}<span class="rc-detail">${c.value}${meta.unit}</span></div>
      ${claimHtml}
    </div>`;
  }).join('');

  list.querySelectorAll('.btn-claim').forEach(btn => {
    btn.onclick = () => {
      btn.disabled = true;
      socket.emit('claimEventReward', { category: btn.dataset.category });
    };
  });
}

function openClaimLayer(category, pointAmount, moneyAmount) {
  const meta = EVENT_CATEGORY_META[category];
  document.getElementById('cl-icon').textContent = meta.icon;
  document.getElementById('cl-cat').textContent = meta.label;
  const lines = [
    pointAmount ? `+${pointAmount.toLocaleString()}점` : null,
    moneyAmount ? `+₩${moneyAmount.toLocaleString()}` : null,
  ].filter(Boolean);
  document.getElementById('cl-amount').innerHTML = lines.map(l => `<span>${l}</span>`).join('');
  const layer = document.getElementById('claim-layer');
  layer.classList.remove('show');
  void layer.offsetWidth; // 리플로우 강제 — 연속 수령 시 애니메이션 재시작되게
  layer.classList.add('show');
}
document.getElementById('btn-claim-confirm').onclick = () => {
  document.getElementById('claim-layer').classList.remove('show');
};

socket.on('eventClaimSuccess', ({ category, pointAmount, moneyAmount, singlePoints, multiBalance }) => {
  me.singlePoints = singlePoints;
  me.multiBalance = multiBalance;
  updateMainScreen();
  document.getElementById('event-msg').textContent = '';
  if (eventData?.results?.[category]) eventData.results[category].claimed = true;
  if (eventData) { renderEventResults(eventData); updateEventBadge(eventData); }
  openClaimLayer(category, pointAmount, moneyAmount);
});
socket.on('eventClaimError', (msg) => {
  document.getElementById('event-msg').style.color = '#ff6b6b';
  document.getElementById('event-msg').textContent = msg;
  if (eventData) renderEventResults(eventData);
});

// ── Help ───────────────────────────────────────────────────────────────
document.getElementById('btn-help').onclick = () => showScreen('screen-help');
document.getElementById('btn-back-help').onclick = () => showScreen('screen-main');
