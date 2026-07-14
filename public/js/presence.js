// ── 접속중 표시 & 멀티 초대 (index.html / game.html 공통) ─────────────────
// main.js 또는 game.js가 먼저 로드되어 socket, getCookie 가 이미 존재한다고 가정.
(function () {
  const PRESENCE_AVATAR_MAP = (typeof AVATAR_MAP !== 'undefined') ? AVATAR_MAP : {
    person: '👤', cat: '🐱', bear: '🐻', rabbit: '🐰', fox: '🦊', frog: '🐸', panda: '🐼', koala: '🐨',
    lion: '🦁', hedge: '🦔', wolf: '🐺', raccoon: '🦝', cow: '🐮', chick: '🐤', monkey: '🐵', turtle: '🐢',
    dolphin: '🐬', seal: '🦭', sheep: '🐑'
  };

  // ── 탭 표시 여부 → 접속중 신호 (10초 유예) ────────────────────────────
  let hiddenTimer = null;
  function sendPresence(visible) {
    if (!socket.connected) return;
    socket.emit(visible ? 'presenceVisible' : 'presenceHidden');
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (hiddenTimer) { clearTimeout(hiddenTimer); hiddenTimer = null; }
      sendPresence(true);
    } else {
      hiddenTimer = setTimeout(() => { hiddenTimer = null; sendPresence(false); }, 10000);
    }
  });
  socket.on('connect', () => { if (document.visibilityState === 'visible') sendPresence(true); });
  socket.on('loginSuccess', () => { if (document.visibilityState === 'visible') sendPresence(true); });

  // ── 작은 토스트 (main.js/game.js 각자의 알림 UI에 안 얹고 독립적으로 뜸) ──
  function presenceToast(msg) {
    const t = document.createElement('div');
    t.textContent = msg;
    Object.assign(t.style, {
      position: 'fixed', bottom: '24px', left: '50%', transform: 'translateX(-50%)',
      background: '#1e1e1e', color: '#fff', padding: '10px 16px', borderRadius: '8px',
      fontSize: '13px', zIndex: '3000', boxShadow: '0 8px 20px rgba(0,0,0,0.5)',
      maxWidth: '80vw', textAlign: 'center'
    });
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2200);
  }

  // ── 대기 pill (초대 보낸 사람) ─────────────────────────────────────────
  window.presencePending = false;
  let pillEl = null;
  function ensurePill() {
    if (pillEl) return pillEl;
    pillEl = document.createElement('div');
    pillEl.id = 'presence-pending-pill';
    document.body.appendChild(pillEl);
    return pillEl;
  }
  function showPendingPill(name) {
    const el = ensurePill();
    el.className = '';
    el.innerHTML = `<span>🔔 ${name}님에게 초대 보냄 · 대기중</span><span class="cancel" id="presence-cancel-btn">✕</span>`;
    document.getElementById('presence-cancel-btn').onclick = () => {
      socket.emit('cancelInvite');
      hidePill();
    };
  }
  function showResultPill(text, ok) {
    const el = ensurePill();
    el.className = 'result' + (ok ? ' accept' : '');
    el.innerHTML = `<span>${text}</span>`;
    setTimeout(hidePill, 3000);
  }
  function hidePill() {
    if (pillEl) { pillEl.remove(); pillEl = null; }
    window.presencePending = false;
  }

  socket.on('inviteSent', ({ toName }) => {
    window.presencePending = true;
    showPendingPill(toName);
  });
  socket.on('inviteError', (msg) => {
    window.presencePending = false;
    hidePill();
    alert(msg);
  });
  socket.on('inviteDeclined', ({ byName }) => {
    window.presencePending = false;
    showResultPill(`🙅 ${byName}님이 초대를 거절했어요`, false);
  });

  // ── 초대 수신 레이어 (받는 사람) ───────────────────────────────────────
  let overlayEl = null;
  function ensureOverlay() {
    if (overlayEl) return overlayEl;
    overlayEl = document.createElement('div');
    overlayEl.id = 'presence-invite-overlay';
    overlayEl.innerHTML = `
      <div id="presence-invite-card">
        <div class="bell">🔔</div>
        <div class="from" id="presence-invite-from"></div>
        <div class="msg">멀티모드 같이 하자!</div>
        <div class="btns">
          <button class="btn-gold" id="presence-invite-accept">수락</button>
          <button class="btn-ghost" id="presence-invite-decline">거절</button>
        </div>
        <div class="foot">수락하면 진행 중인 싱글 게임은 종료돼요</div>
      </div>`;
    document.body.appendChild(overlayEl);
    document.getElementById('presence-invite-accept').onclick = () => respondInvite(true);
    document.getElementById('presence-invite-decline').onclick = () => respondInvite(false);
    return overlayEl;
  }
  function respondInvite(accept) {
    socket.emit('respondInvite', { accept });
    overlayEl?.classList.remove('show');
  }
  socket.on('inviteReceived', ({ fromName, fromAvatar }) => {
    ensureOverlay();
    const emoji = PRESENCE_AVATAR_MAP[fromAvatar] || '👤';
    document.getElementById('presence-invite-from').innerHTML = `<span>${emoji}</span>${fromName}님`;
    overlayEl.classList.add('show');
  });
  socket.on('inviteCancelled', () => {
    overlayEl?.classList.remove('show');
  });

  // ── 수락 처리: 양쪽 다 같은 방식으로 대기실 입장 ──────────────────────────
  socket.on('inviteResponded', ({ accepted, byName }) => {
    if (accepted) showResultPill(`✅ ${byName}님이 수락했어요`, true);
  });
  socket.on('inviteAccepted', () => {
    hidePill();
    overlayEl?.classList.remove('show');
    presenceToast('방으로 이동합니다...');
    setTimeout(() => {
      if (location.pathname.indexOf('game.html') !== -1) {
        sessionStorage.setItem('autoJoinWaiting', '1');
        socket.disconnect();
        location.href = '/';
      } else {
        socket.emit('joinWaitingViaInvite');
      }
    }, 700);
  });
})();
