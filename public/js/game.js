const socket = io({ transports: ['websocket'] });
if ('ontouchstart' in window) document.body.classList.add('mobile');

function getCookie(name) {
  const v = document.cookie.match(`(?:^|; )${name}=([^;]*)`);
  return v ? decodeURIComponent(v[1]) : null;
}

const userCode = getCookie('userCode');
const userName = getCookie('userName');
const gameMode = getCookie('gameMode');
const isAdmin  = getCookie('isAdmin') === '1';

if (!userCode) location.href = '/';

const AVATAR_MAP = {
  person: '👤', cat: '🐱', bear: '🐻', rabbit: '🐰', fox: '🦊',
  frog: '🐸', panda: '🐼', koala: '🐨', lion: '🦁', hedge: '🦔',
  wolf: '🐺', raccoon: '🦝', cow: '🐮',
  chick: '🐤', monkey: '🐵', turtle: '🐢', dolphin: '🐬', seal: '🦭', sheep: '🐑',
  pig: '🐷', dog: '🐶', tiger: '🐯'
};

// 싱글 1등 = 👑, 멀티 1등 = 💎 (둘 다면 같이 표시)
function rankBadgeHtml(p) {
  // 지금 하고 있는 모드에 해당하는 뱃지만 표시 (다른 모드 1등이어도 안 보임)
  if (gameMode === 'multi') return p.isRank1Multi ? '<span class="badge-icon">💎</span>' : '';
  return p.isRank1Single ? '<span class="badge-icon">👑</span>' : '';
}

// 이름/잔액이 잘려서 "..."로 안 보이게, 넘치면 폰트 크기를 줄여서 전체가 보이도록 함
function fitText(el, minPx = 8) {
  el.style.fontSize = '';
  const naturalSize = parseFloat(getComputedStyle(el).fontSize);
  let size = naturalSize;
  el.style.fontSize = size + 'px';
  while (el.scrollWidth > el.clientWidth + 0.5 && size > minPx) {
    size -= 1;
    el.style.fontSize = size + 'px';
  }
}

let gameState = null;
let prevThankYouActive = false;
let wakeLock = null;
let selectedCards = new Set();
let timerInterval = null;
let timerSeconds = 45;
let thankYouLocked = false;
let attachMode = false;
let myFixedSeat = null;
let sortMode = null;
let lastTurnPlayerCode = null;
let lastDrawSource = null; // 'deck' | 'discard' | 'thankYou'
let prevHandCounts = new Map(); // userCode → handCount
let lastDiscardCardData = null; // 버린더미 hidden 시 흐릿하게 보여줄 마지막 카드
let markedCardId = null; // 점 표시할 카드 ID
let markedCardSource = null; // 'deck' | 'thankYou'
let pendingThankYouPlayerCode = null; // 땡큐한 플레이어 (카드 날아오는 방향용)
let pendingThankYouCard = null; // 내가 땡큐 시도한 카드 (확인 후 애니메이션용)

// ── Wake Lock ──────────────────────────────────────────────────────────
async function requestWakeLock() {
  if (!('wakeLock' in navigator) || wakeLock) return;
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch (_) {}
}
function releaseWakeLock() {
  if (wakeLock) { wakeLock.release(); wakeLock = null; }
}
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible') {
    if (gameState?.status === 'playing') requestWakeLock();
    if (!socket.connected) socket.connect();
  } else {
    releaseWakeLock();
  }
});

// ── Init ───────────────────────────────────────────────────────────────
// connect는 최초 연결 + 재연결 모두 발생하므로 여기서 login 전송
socket.on('connect', () => {
  document.getElementById('network-banner')?.classList.remove('show');
  socket.emit('login', { userCode });
});
socket.on('disconnect', () => {
  document.getElementById('network-banner')?.classList.add('show');
});

let initialConnectDone = false;
socket.on('loginSuccess', () => {
  if (gameMode === 'single' && !gameState && !initialConnectDone) {
    initialConnectDone = true;
    socket.emit('startSingle');
  }
  // Multi: server sends gameState automatically
});

if (isAdmin || gameMode === 'single') {
  document.getElementById('admin-controls').style.display = '';
  document.getElementById('btn-admin-stop').onclick = () => {
    if (confirm('게임을 중단하시겠습니까?')) socket.emit('adminStopGame');
  };
}

// 일시정지: 싱글모드에서만 노출
if (gameMode === 'single') {
  document.getElementById('btn-pause').style.display = '';
  document.getElementById('btn-pause').onclick = () => socket.emit('pauseGame');
  document.getElementById('btn-resume').onclick = () => socket.emit('resumeGame');
}

// ── Game State ─────────────────────────────────────────────────────────
socket.on('gameState', (state) => {
  requestWakeLock();
  // 새 게임 시작 시 결과 화면 숨기기 + 카드 배분 애니메이션
  if (!gameState || state.id !== gameState.id) {
    document.getElementById('overlay-gameend').style.display = 'none';
    document.getElementById('overlay-results').style.display = 'none';
    selectedCards.clear();
    myFixedSeat = null;
    lastTurnPlayerCode = null;
    prevThankYouActive = false;
    prevComboTotal = 0;
    prevHandCounts.clear();
    lastDiscardCardData = null;
    markedCardId = null;
    markedCardSource = null;
    pendingThankYouPlayerCode = null;
    if (state.id !== gameState?.id) showDealingAnimation();
  }
  const newThankYouActive = !!state.thankYou?.active;
  prevThankYouActive = newThankYouActive;

  gameState = state;

  // 일시정지 화면 표시/해제 (재접속 시에도 서버 상태 기준으로 정확히 복원됨)
  const pauseOverlay = document.getElementById('pause-overlay');
  if (pauseOverlay) {
    pauseOverlay.classList.toggle('show', !!state.paused);
    if (state.paused) releaseWakeLock(); else requestWakeLock();
  }
  if (myFixedSeat === null) {
    const me = state.players.find(p => p.userCode === userCode);
    if (me !== undefined) myFixedSeat = me.seatIndex;
  }
  // 타이머는 턴이 바뀔 때만 리셋
  const turnChanged = state.currentPlayerCode !== lastTurnPlayerCode;
  if (turnChanged) {
    lastTurnPlayerCode = state.currentPlayerCode;
    updateTimer();
    markedCardId = null;
    markedCardSource = null;
    if (state.currentPlayerCode !== userCode) selectedCards.clear();
  }
  render();
});

socket.on('gameStopped', () => {
  showNotif('게임이 중단되었습니다', 'info');
  setTimeout(() => { socket.disconnect(); location.href = '/'; }, 2000);
});

socket.on('multiKicked', () => {
  showNotif('잔액이 없어 멀티모드에서 퇴장됩니다.', 'info');
  setTimeout(() => { socket.disconnect(); location.href = '/'; }, 3000);
});

socket.on('playAgainError', (msg) => {
  showNotif(msg, 'info');
  setTimeout(() => { socket.disconnect(); location.href = '/'; }, 3000);
});

socket.on('duplicateLogin', () => {
  socket.disconnect();
  releaseWakeLock();
  sessionStorage.setItem('kicked', '1');
  alert('다른 기기에서 같은 계정으로 접속했습니다.');
  location.href = '/';
});

socket.on('canStop', () => {
  showNotif('상대방이 모두 나갔습니다. 게임을 중단할 수 있습니다.', 'info');
});

socket.on('actionError', (msg) => {
  // 낙관적으로 바꾼 phase를 서버가 거부하면 되돌림
  if (gameState && gameState.phase === 'action' && lastDrawSource) {
    gameState.phase = 'draw';
    lastDrawSource = null;
  }
  if (gameState) render(); // 항상 UI 상태 동기화 (유령 선택 상태 방지)
  showNotif(msg, 'info');
});
socket.on('deckEmpty', () => showNotif('카드 덱이 소진됐습니다! 이번 버림 후 카드 합산으로 순위 결정', 'info'));

// ── Render ─────────────────────────────────────────────────────────────
let prevComboTotal = 0; // 이전 렌더 시점 콤보 카드 총 수

function render() {
  if (!gameState) return;
  const me = gameState.players.find(p => p.userCode === userCode);
  const others = getOtherSeats(myFixedSeat ?? me?.seatIndex);

  const currentComboTotal = (gameState.combos || []).reduce((s, c) => s + c.cards.length, 0);
  const comboGrew = currentComboTotal > prevComboTotal;
  prevComboTotal = currentComboTotal;

  renderPlayer('top', others[0], comboGrew);
  renderPlayer('left', others[1], comboGrew);
  renderPlayer('right', others[2], comboGrew);
  renderMyArea(me);
  renderCenter();
  updateActionButtons(me);
}

function getOtherSeats(mySeat) {
  if (mySeat === undefined || mySeat === null) return [null, null, null];
  const n = gameState.players.length;
  const positions = [];
  for (let i = 1; i <= 3; i++) {
    const idx = (mySeat + i) % n;
    positions.push(gameState.players[idx] || null);
  }
  // 시계방향: +1=오른쪽, +2=위, +3=왼쪽
  return [positions[1], positions[2], positions[0]]; // top, left, right
}

function renderPlayer(pos, player, comboGrew = false) {
  const el = document.getElementById(`player-${pos}`);
  if (!player) { el.style.visibility = 'hidden'; return; }
  el.style.visibility = '';

  const isCurrent = gameState.currentPlayerCode === player.userCode;
  el.classList.toggle('active', isCurrent);

  // 상대방 카드 수 변화 감지 → 모션
  const prevCount = prevHandCounts.get(player.userCode) ?? player.handCount;
  if (player.handCount > prevCount) {
    const fromEl = pendingThankYouPlayerCode === player.userCode
      ? document.getElementById('discard-card')
      : document.getElementById('deck-card');
    pendingThankYouPlayerCode = null;
    flyCard(fromEl, el);
  } else if (player.handCount < prevCount) {
    // 등록/붙이기면 가운데(콤보 영역)로, 버리기면 버린더미로
    const toEl = comboGrew
      ? document.getElementById('combos-area')
      : document.getElementById('discard-card');
    flyCard(el, toEl, false, null, comboGrew ? 380 : 550);
  }
  prevHandCounts.set(player.userCode, player.handCount);

  const avatarEmoji = AVATAR_MAP[player.avatar] || (player.isAI ? '🤖' : '👤');
  const nameEl = el.querySelector('.player-name');
  nameEl.innerHTML = rankBadgeHtml(player) + avatarEmoji + ' ' + player.userName;
  fitText(nameEl);
  const balanceEl = el.querySelector('.player-balance');
  balanceEl.textContent = gameMode === 'multi' && player.multiBalance !== undefined
    ? `₩${player.multiBalance.toLocaleString()}` : '';
  fitText(balanceEl);
  el.querySelector('.player-registered').textContent = player.registered ? '✓등록' : '';

  const cardsEl = el.querySelector('.player-cards');
  cardsEl.innerHTML = '';
  for (let i = 0; i < player.handCount; i++) {
    const c = document.createElement('div');
    c.className = 'card card-back tiny';
    cardsEl.appendChild(c);
  }
}

function getSortedHand(hand) {
  if (!sortMode) return hand;
  const sorted = [...hand];
  const suitOrder = { S: 0, H: 1, D: 2, C: 3 };
  if (sortMode === 'number') sorted.sort((a, b) => a.value - b.value || suitOrder[a.suit] - suitOrder[b.suit]);
  if (sortMode === 'suit')   sorted.sort((a, b) => suitOrder[a.suit] - suitOrder[b.suit] || a.value - b.value);
  return sorted;
}

function renderMyArea(me) {
  if (!me) return;
  const isCurrent = gameState.currentPlayerCode === userCode;
  const phase = gameState.phase;

  const myAvatar = AVATAR_MAP[me.avatar] || '👤';
  const myNameEl = document.getElementById('my-name');
  myNameEl.innerHTML = rankBadgeHtml(me) + myAvatar + ' ' + userName;
  fitText(myNameEl);
  const myBalanceEl = document.getElementById('my-balance');
  myBalanceEl.textContent = gameMode === 'multi'
    ? `₩${(me.multiBalance || 0).toLocaleString?.() || ''}` : `${(me.singlePoints || 0).toLocaleString()}pt`;
  fitText(myBalanceEl);
  document.getElementById('my-registered').textContent = me.registered ? '✓등록' : '';
  document.getElementById('my-character').classList.toggle('active', isCurrent);

  // 손패 카드 영역만 강조 (내 차례 + 행동 단계)
  document.getElementById('my-hand').classList.toggle('my-turn-highlight', isCurrent && phase === 'action');

  const rawHand = me.hand || [];
  const hand = getSortedHand(rawHand);
  const handEl = document.getElementById('my-hand');

  const currentIds = [...handEl.querySelectorAll('.card-slot[data-card-id]')]
    .filter(el => !el.classList.contains('card-leaving'))
    .map(el => el.dataset.cardId);
  const newIds = hand.map(c => c.id);
  const handChanged = currentIds.join(',') !== newIds.join(',');

  if (handChanged) {
    const addedIds = new Set(newIds.filter(id => !currentIds.includes(id)));
    // 새 카드가 1장 들어왔고 출처가 있으면 점 마킹
    if (addedIds.size === 1 && lastDrawSource) {
      markedCardId = [...addedIds][0];
      markedCardSource = lastDrawSource;
      lastDrawSource = null;
    }
    handEl.innerHTML = '';
    for (const card of hand) {
      const el = createCardEl(card);
      el.onclick = () => toggleCardSelect(card.id, el);
      if (selectedCards.has(card.id)) el.classList.add('selected');
      if (addedIds.has(card.id)) el.classList.add('card-entering');
      if (card.id === markedCardId) {
        el.querySelector('.card').classList.add(
          markedCardSource === 'thankYou' ? 'card-dot-thankyou' : 'card-dot-deck'
        );
      }
      handEl.appendChild(el);
    }
  } else {
    // 버린 카드 슬롯 제거 → 첫 번째 카드 margin 정상화
    handEl.querySelectorAll('.card-slot.card-leaving').forEach(el => el.remove());
    handEl.querySelectorAll('.card-slot[data-card-id]').forEach(el => {
      el.classList.toggle('selected', selectedCards.has(el.dataset.cardId));
      const cardEl = el.querySelector('.card');
      if (cardEl) {
        cardEl.classList.remove('card-dot-deck', 'card-dot-thankyou');
        if (el.dataset.cardId === markedCardId) {
          cardEl.classList.add(markedCardSource === 'thankYou' ? 'card-dot-thankyou' : 'card-dot-deck');
        }
      }
    });
  }
}

function renderCenter() {
  // Deck
  const deckCount = gameState.deck?.count || 0;
  document.getElementById('deck-count').textContent = deckCount;

  // Discard pile
  const discardEl = document.getElementById('discard-card');
  const discardPile = gameState.discardPile;
  if (discardPile) {
    if (discardPile.hidden) {
      // 카드 앞면 유지하되 흐릿하게 (땡큐 불가 신호)
      discardEl.innerHTML = '';
      const dimCard = discardPile.top || lastDiscardCardData;
      if (dimCard) {
        discardEl.className = 'card ' + getCardColorClass(dimCard) + ' discard-dimmed';
        discardEl.appendChild(cardInnerEl(dimCard));
      } else {
        discardEl.className = 'card discard-dimmed';
      }
      discardEl.dataset.topId = '';
      discardEl.onclick = null;
    } else {
      const prevTopId = discardEl.dataset.topId;
      const newTopId = discardPile.top?.id;
      lastDiscardCardData = discardPile.top; // 마지막 카드 기억
      discardEl.innerHTML = '';
      discardEl.className = 'card ' + getCardColorClass(discardPile.top);
      discardEl.dataset.topId = newTopId;
      discardEl.appendChild(cardInnerEl(discardPile.top));
      if (prevTopId !== newTopId) {
        discardEl.classList.add('discard-pop');
        setTimeout(() => discardEl.classList.remove('discard-pop'), 400);
      }
      discardEl.onclick = () => handleDraw('discard');
    }
  } else {
    discardEl.innerHTML = '';
    discardEl.className = 'card';
    discardEl.textContent = '없음';
    discardEl.onclick = null;
  }

  // Deck click
  document.getElementById('deck-card').onclick = () => handleDraw('deck');

  // 내 차례 + 드로우 단계일 때 덱 강조 (땡큐 활성 중에도 덱은 가능)
  const drawPhase = isMyTurn() && gameState.phase === 'draw';
  document.getElementById('deck-pile').classList.toggle('my-turn-highlight', drawPhase);
  // 버린더미는 땡큐 활성 중 차단
  document.getElementById('discard-pile').classList.toggle('my-turn-highlight',
    drawPhase && !!gameState.discardPile && !gameState.discardPile.hidden && !gameState.firstTurn && !gameState.thankYou?.active);

  // Thank you button
  const btn = document.getElementById('btn-thankyou');
  const tyActive = gameState.thankYou?.active;
  const tyLocked = gameState.thankYou?.lock;
  btn.disabled = !tyActive || !!tyLocked || gameState.thankYou?.discarderCode === userCode;

  // 취소 버튼: 내가 땡큐로 카드 가져온 후 내 턴 동안 표시
  const iMyThankYouTaker = gameState.thankYouTaker === userCode && isMyTurn();
  thankYouLocked = iMyThankYouTaker;
  document.getElementById('btn-cancel-thankyou').style.display = iMyThankYouTaker ? '' : 'none';

  // Combos
  renderCombos();
}

function sortComboCards(cards, type) {
  const suitOrder = { S: 0, H: 1, D: 2, C: 3 };
  if (type === 'set') {
    return [...cards].sort((a, b) => suitOrder[a.suit] - suitOrder[b.suit]);
  }
  if (type === 'sequence') {
    const sorted = [...cards].sort((a, b) => a.value - b.value);
    const n = sorted.length;
    // 숫자 간 가장 큰 순환 갭 찾기 → 갭 다음 카드가 시작점
    // 예) K-A-2: [1,2,13] → 2와13 갭(11)이 최대 → 13(K)부터 → [K,A,2]
    let maxGap = 0, startIdx = 0;
    for (let i = 0; i < n; i++) {
      const curr = sorted[i].value;
      const next = sorted[(i + 1) % n].value;
      const gap = next > curr ? next - curr : next + 13 - curr;
      if (gap > maxGap) { maxGap = gap; startIdx = (i + 1) % n; }
    }
    return [...sorted.slice(startIdx), ...sorted.slice(0, startIdx)];
  }
  return cards;
}

function renderCombos() {
  const area = document.getElementById('combos-area');
  area.innerHTML = '';

  for (const combo of (gameState.combos || [])) {
    const group = document.createElement('div');
    group.className = 'combo-group';
    group.dataset.comboId = combo.id;

    const sorted = sortComboCards(combo.cards, combo.type);
    // 모든 카드 겹쳐서 표시 — 오른쪽 카드가 위에(z-index 높음)
    // 왼쪽 카드들은 왼쪽 끝(숫자/모양)만 보임, 맨 오른쪽 카드는 완전히 보임
    sorted.forEach((card, i) => {
      const el = createCardEl(card, 'small combo-card');
      el.style.marginLeft = i === 0 ? '0' : '-20px';
      el.style.zIndex = i;
      group.appendChild(el);
    });

    group.onclick = () => handleComboClick(combo.id);
    area.appendChild(group);
  }
}

function createCardEl(card, size = '') {
  const slot = document.createElement('div');
  slot.className = 'card-slot';
  slot.dataset.cardId = card.id;
  const el = document.createElement('div');
  el.className = `card ${getCardColorClass(card)}${size ? ' ' + size : ''}`;
  el.appendChild(cardInnerEl(card));
  slot.appendChild(el);
  return slot;
}

function cardInnerEl(card) {
  const inner = document.createElement('div');
  inner.className = 'card-inner';
  const valueNames = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' };
  const suitSymbols = { S: '♠', H: '♥', D: '♦', C: '♣' };
  inner.innerHTML = `<span>${valueNames[card.value] || card.value}</span><span class="card-suit">${suitSymbols[card.suit]}</span>`;
  return inner;
}

function getCardColorClass(card) {
  return (card.suit === 'H' || card.suit === 'D') ? 'red' : 'black';
}

function flyCard(fromEl, toEl, faceUp = false, cardData = null, duration = 380) {
  if (!fromEl || !toEl) return;
  const from = fromEl.getBoundingClientRect();
  const to = toEl.getBoundingClientRect();
  if (!from.width || !from.height || !to.width || !to.height) return;

  // 카드 크기 고정 (작은 카드 크기)
  const cardW = Math.min(from.width, 52);
  const cardH = Math.min(from.height, 72);

  // 출발: fromEl 중앙
  const startLeft = from.left + (from.width - cardW) / 2;
  const startTop  = from.top  + (from.height - cardH) / 2;

  // 도착: toEl 중앙
  const endLeft = to.left + (to.width  - cardW) / 2;
  const endTop  = to.top  + (to.height - cardH) / 2;

  const clone = document.createElement('div');
  clone.className = faceUp && cardData
    ? `card small ${getCardColorClass(cardData)}`
    : 'card small card-back';
  if (faceUp && cardData) clone.appendChild(cardInnerEl(cardData));

  Object.assign(clone.style, {
    position: 'fixed',
    left: startLeft + 'px',
    top: startTop + 'px',
    width: cardW + 'px',
    height: cardH + 'px',
    zIndex: '999',
    pointerEvents: 'none',
    transition: 'none',
    boxShadow: '2px 4px 16px rgba(0,0,0,0.6)',
    borderRadius: '6px',
  });
  document.body.appendChild(clone);

  requestAnimationFrame(() => requestAnimationFrame(() => {
    const dur = duration;
    Object.assign(clone.style, {
      transition: `left ${dur}ms cubic-bezier(.25,0.46,0.45,0.94), top ${dur}ms cubic-bezier(.25,0.46,0.45,0.94), opacity ${Math.round(dur*0.47)}ms ease ${Math.round(dur*0.84)}ms`,
      left: endLeft + 'px',
      top: endTop + 'px',
      opacity: '0',
    });
    setTimeout(() => clone.remove(), dur + 140);
  }));
}

function cardName(card) {
  const valueNames = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' };
  const suitSymbols = { S: '♠', H: '♥', D: '♦', C: '♣' };
  return `${suitSymbols[card.suit]}${valueNames[card.value] || card.value}`;
}

// ── Actions ────────────────────────────────────────────────────────────
function isMyTurn() {
  return gameState?.currentPlayerCode === userCode;
}

function handleDraw(source) {
  if (document.getElementById('dealing-overlay')) return;
  if (!isMyTurn()) return;
  if (gameState.phase !== 'draw') return;
  if (source === 'discard' && gameState.thankYou?.active) return;

  gameState.phase = 'action'; // 즉시 phase 변경 → 중복 드로우 차단

  const fromEl = source === 'discard'
    ? document.getElementById('discard-card')
    : document.getElementById('deck-card');
  // 버린더미에서 가져갈 땐 앞면, 덱에서 가져갈 땐 뒷면
  const discardCard = source === 'discard' ? gameState.discardPile?.top : null;
  flyCard(fromEl, document.getElementById('my-hand'), source === 'discard', discardCard);
  lastDrawSource = source;

  socket.emit('draw', { source });
  selectedCards.clear();
}

function toggleCardSelect(cardId, el) {
  if (!isMyTurn()) return;
  if (gameState.phase !== 'action') return;

  if (selectedCards.has(cardId)) {
    selectedCards.delete(cardId);
    el.classList.remove('selected');
  } else {
    selectedCards.add(cardId);
    el.classList.add('selected');
  }
  updateActionButtons(gameState.players.find(p => p.userCode === userCode));
}

function handleComboClick(comboId) {
  if (!attachMode) return;
  const cardIds = [...selectedCards];
  if (cardIds.length === 0) return;
  socket.emit('attach', { cardIds, comboId });
  selectedCards.clear();
  attachMode = false;
  document.getElementById('modal-attach').style.display = 'none';
}

document.getElementById('btn-register').onclick = () => {
  const cardIds = [...selectedCards];
  if (cardIds.length === 0) return;
  socket.emit('register', { cardIds });
  selectedCards.clear();
};

document.getElementById('btn-attach').onclick = () => {
  const cardIds = [...selectedCards];
  if (cardIds.length === 0) { showNotif('붙일 카드를 선택하세요', 'info'); return; }
  if (cardIds.length > 1) { showNotif('한장씩 선택하여 붙이기 해주세요', 'info'); return; }

  // Show combo selector (판에 깔린 순서대로, 카드 겹쳐서 표시)
  const list = document.getElementById('attach-combo-list');
  list.innerHTML = '';
  for (const combo of (gameState.combos || [])) {
    const item = document.createElement('div');
    item.className = 'attach-combo-item';
    const sorted = sortComboCards(combo.cards, combo.type);
    sorted.forEach((card, i) => {
      const el = createCardEl(card, 'small combo-card');
      el.style.marginLeft = i === 0 ? '0' : '-20px';
      el.style.zIndex = i;
      item.appendChild(el);
    });
    item.onclick = () => {
      socket.emit('attach', { cardIds, comboId: combo.id });
      selectedCards.clear();
      attachMode = false;
      document.getElementById('modal-attach').style.display = 'none';
    };
    list.appendChild(item);
  }
  attachMode = true;
  document.getElementById('modal-attach').style.display = 'flex';
};

document.getElementById('btn-attach-cancel').onclick = () => {
  attachMode = false;
  document.getElementById('modal-attach').style.display = 'none';
};

document.getElementById('btn-discard').onclick = () => {
  const cardIds = [...selectedCards];
  if (cardIds.length !== 1) { showNotif('버릴 카드 1장을 선택하세요', 'info'); return; }
  const cardEl = document.querySelector(`#my-hand [data-card-id="${cardIds[0]}"]`);
  if (cardEl) {
    cardEl.classList.remove('selected');
    cardEl.classList.add('card-leaving');
    flyCard(cardEl.querySelector('.card'), document.getElementById('discard-card'));
    // 슬롯 너비를 0으로 접어서 빈 자리 없애기
    cardEl.style.overflow = 'hidden';
    cardEl.style.transition = 'width 0.2s ease 0.05s, margin-left 0.2s ease 0.05s, min-width 0.2s ease 0.05s';
    requestAnimationFrame(() => {
      cardEl.style.width = '0';
      cardEl.style.minWidth = '0';
      cardEl.style.marginLeft = '0';
    });
    setTimeout(() => {
      socket.emit('discard', { cardId: cardIds[0] });
      selectedCards.clear();
    }, 220);
  } else {
    socket.emit('discard', { cardId: cardIds[0] });
    selectedCards.clear();
  }
};

// ── Sort ───────────────────────────────────────────────────────────────
document.getElementById('btn-sort-num').onclick = () => { sortMode = 'number'; renderMyArea(gameState?.players.find(p => p.userCode === userCode)); };
document.getElementById('btn-sort-suit').onclick = () => { sortMode = 'suit'; renderMyArea(gameState?.players.find(p => p.userCode === userCode)); };
document.getElementById('btn-sort-off').onclick = () => { sortMode = null; renderMyArea(gameState?.players.find(p => p.userCode === userCode)); };

document.getElementById('btn-thankyou').onclick = () => {
  const btn = document.getElementById('btn-thankyou');
  if (btn.disabled) {
    const state = gameState?.thankYou;
    if (state?.lock) showNotif('이미 선점됐어요', 'info');
    return;
  }
  pendingThankYouCard = gameState.thankYou?.card;
  lastDrawSource = 'thankYou';
  socket.emit('thankYou');
};

socket.on('thankYouFailed', ({ msg }) => {
  pendingThankYouCard = null;
  if (msg?.includes('이미')) showNotif('다른 사람이 가져갔어요', 'info');
  else showNotif(msg || '땡큐 실패', 'info');
});

document.getElementById('btn-cancel-thankyou').onclick = () => {
  const othersCount = (gameState?.players?.length ?? 4) - 1;
  const unit = gameMode === 'multi' ? 100 : 1;
  const suffix = gameMode === 'multi' ? '원' : 'pt';
  const penalty = unit * othersCount;
  document.getElementById('cancel-penalty-text').innerHTML =
    `취소하면 벌금 <strong>-${penalty}${suffix}</strong>이 부과됩니다.<br>나머지 플레이어에게 +${unit}${suffix}씩 지급됩니다.`;
  document.getElementById('modal-cancel-confirm').style.display = 'flex';
};
document.getElementById('btn-cancel-confirm-no').onclick = () => {
  document.getElementById('modal-cancel-confirm').style.display = 'none';
};
document.getElementById('btn-cancel-confirm-yes').onclick = () => {
  document.getElementById('modal-cancel-confirm').style.display = 'none';
  socket.emit('cancelThankYou');
};

socket.on('thankYouCancelled', ({ cancellerCode, penalty, gain, auto }) => {
  showBubble(cancellerCode, '땡큐 취소! 😭');
  const unit = gameMode === 'multi' ? '원' : 'pt';
  if (cancellerCode === userCode) {
    if (auto) {
      document.getElementById('auto-cancel-penalty').textContent = `-${penalty.toLocaleString()}${unit}`;
      document.getElementById('modal-auto-cancel').style.display = 'flex';
    } else {
      showNotif(`벌금 -${penalty.toLocaleString()}${unit} 부과`, 'lose-money');
    }
  } else {
    showNotif(`+${gain.toLocaleString()}${unit} 지급`, 'win-money');
  }
});
document.getElementById('btn-auto-cancel-ok').onclick = () => {
  document.getElementById('modal-auto-cancel').style.display = 'none';
};


function updateActionButtons(me) {
  if (!me) return;
  const isTurn = isMyTurn();
  const phase = gameState?.phase;
  const hasSelected = selectedCards.size > 0;

  document.getElementById('btn-register').disabled = !isTurn || phase !== 'action' || !hasSelected;
  document.getElementById('btn-attach').disabled = !isTurn || phase !== 'action' || !hasSelected || !me.registered;
  const isThankYouTaker = gameState?.thankYouTaker === userCode;
  document.getElementById('btn-discard').disabled = !isTurn || phase !== 'action' || selectedCards.size !== 1 || isThankYouTaker;
}

// ── Timer ──────────────────────────────────────────────────────────────
function updateTimer() {
  if (!gameState) return;
  if (timerInterval) clearInterval(timerInterval);

  const circle = document.getElementById('timer-circle');
  const text = document.getElementById('timer-text');
  const circumference = 163.4;

  // 내 차례가 아니면 카운트다운 안 함
  if (!isMyTurn()) {
    timerSeconds = 45;
    text.textContent = '45';
    circle.style.strokeDashoffset = '0';
    circle.classList.remove('urgent');
    return;
  }

  timerSeconds = 45;

  function tick() {
    text.textContent = timerSeconds;
    const offset = circumference * (1 - timerSeconds / 45);
    circle.style.strokeDashoffset = offset;
    circle.classList.toggle('urgent', timerSeconds <= 15);
    if (timerSeconds <= 0) clearInterval(timerInterval);
    timerSeconds--;
  }
  tick();
  timerInterval = setInterval(tick, 1000);
}

// ── Game End ───────────────────────────────────────────────────────────
socket.on('gameEnd', ({ results, winnerCode, winnerName, winMessage, newRank1 }) => {
  clearInterval(timerInterval);
  releaseWakeLock();

  const overlay = document.getElementById('overlay-gameend');
  overlay.style.display = 'flex';

  const winnerResult = results.find(r => r.userCode === winnerCode);
  const winnerAvatar = AVATAR_MAP[winnerResult?.avatar] || '👤';
  document.getElementById('win-avatar').textContent = winnerAvatar;
  document.getElementById('win-name').textContent = `${winnerName} 승리!`;
  document.getElementById('win-message').textContent = winMessage || '';

  // 새로 1위 등극 연출 (싱글=👑, 멀티=💎)
  const badgeSlot = document.getElementById('win-rank1-badge-slot');
  const badgeEmoji = document.getElementById('win-rank1-badge');
  const sub = document.getElementById('win-rank1-sub');
  badgeSlot.classList.remove('play');
  sub.classList.remove('play');
  if (newRank1) {
    badgeEmoji.textContent = newRank1 === 'multi' ? '💎' : '👑';
    sub.textContent = `🎉 ${newRank1 === 'multi' ? '멀티' : '싱글'}모드 1위 등극!`;
    void badgeSlot.offsetWidth; // 애니메이션 재시작을 위한 강제 리플로우
    badgeSlot.classList.add('play');
    sub.classList.add('play');
  } else {
    badgeEmoji.textContent = '';
    sub.textContent = '';
  }

  launchConfetti(winnerCode);

  document.getElementById('btn-gameend-ok').onclick = () => {
    overlay.style.display = 'none';
    showResults(results);
  };
});

function showResults(results) {
  const overlay = document.getElementById('overlay-results');
  overlay.style.display = 'flex';
  const tbody = document.getElementById('results-body');
  tbody.innerHTML = results
    .sort((a, b) => a.rank - b.rank)
    .map(r => {
      const avatarEmoji = AVATAR_MAP[r.avatar] || (r.isAI ? '🤖' : '👤');
      const wins = r.totalWins ?? 0;
      const games = r.totalGames ?? 0;
      const losses = games - wins;
      const record = r.isAI ? '-' : `${wins.toLocaleString()}승 ${losses.toLocaleString()}패`;
      const rate = r.isAI || !games ? '-' : Math.round((wins / games) * 100).toLocaleString() + '%';
      const notes = [];
      if (r.rank !== 1 && r.multiplier === 2) notes.push('미등록×2');
      if (r.thankYouChange) {
        const unit = gameMode === 'multi' ? '원' : 'pt';
        notes.push(`벌금 ${r.thankYouChange > 0 ? '+' : ''}${r.thankYouChange.toLocaleString()}${unit}`);
      }
      return `<tr>
        <td>${r.rank}</td>
        <td>${avatarEmoji} ${r.userName}</td>
        <td>${r.cardSum}</td>
        <td style="color:${r.pointChange >= 0 ? '#4caf50' : '#f44336'}">
          ${r.pointChange >= 0 ? '+' : ''}${r.pointChange?.toLocaleString()}${gameMode === 'multi' ? '원' : 'pt'}
        </td>
        <td>${r.currentBalance !== undefined ? (gameMode === 'multi' ? '₩' + r.currentBalance?.toLocaleString() : r.currentBalance?.toLocaleString() + 'pt') : '-'}</td>
        <td>${record}</td>
        <td>${rate}</td>
        <td style="font-size:0.8em;color:#aaa">${notes.join(' / ') || '-'}</td>
      </tr>`;
    }).join('');
}

document.getElementById('btn-results-home').onclick = () => { socket.disconnect(); location.href = '/'; };

document.getElementById('btn-results-again').onclick = () => {
  document.getElementById('overlay-results').style.display = 'none';
  document.getElementById('overlay-gameend').style.display = 'none';
  document.getElementById('game-log').innerHTML = '';
  gameState = null;
  selectedCards.clear();
  myFixedSeat = null;
  lastTurnPlayerCode = null;
  if (gameMode === 'single') {
    socket.emit('startSingle');
  } else {
    socket.emit('playAgain'); // 관리자가 누르면 같은 멤버로 재시작
  }
};

// ── Confetti ───────────────────────────────────────────────────────────
function launchConfetti(winnerCode) {
  const colors = ['#f1c40f', '#e74c3c', '#3498db', '#2ecc71', '#9b59b6', '#e67e22'];
  const container = document.getElementById('confetti-container');
  container.innerHTML = '';

  // 1등 영역의 위치를 기준으로 꽃가루 생성
  let originX = 50, originY = 50; // 기본: 화면 중앙 (%)
  if (winnerCode === userCode) {
    const el = document.getElementById('my-character');
    if (el) {
      const r = el.getBoundingClientRect();
      originX = ((r.left + r.width / 2) / window.innerWidth) * 100;
      originY = ((r.top + r.height / 2) / window.innerHeight) * 100;
    }
  } else if (gameState) {
    const positions = ['top', 'left', 'right'];
    const others = getOtherSeats(myFixedSeat);
    others.forEach((p, i) => {
      if (p?.userCode === winnerCode) {
        const el = document.getElementById(`player-${positions[i]}`);
        if (el) {
          const r = el.getBoundingClientRect();
          originX = ((r.left + r.width / 2) / window.innerWidth) * 100;
          originY = ((r.top + r.height / 2) / window.innerHeight) * 100;
        }
      }
    });
  }

  for (let i = 0; i < 80; i++) {
    const piece = document.createElement('div');
    piece.className = 'confetti-piece';
    const spread = document.body.classList.contains('mobile') ? 20 : 40;
    piece.style.cssText = `
      left: ${originX + (Math.random() - 0.5) * spread}%;
      top: ${Math.max(0, originY - 10)}%;
      background: ${colors[Math.floor(Math.random() * colors.length)]};
      animation-duration: ${1.5 + Math.random() * 2}s;
      animation-delay: ${Math.random() * 0.8}s;
      transform: rotate(${Math.random() * 360}deg);
    `;
    container.appendChild(piece);
  }
  setTimeout(() => container.innerHTML = '', 4000);
}

// ── ThankYou Announce ──────────────────────────────────────────────────
socket.on('thankYouAnnounce', ({ playerCode, playerName }) => {
  pendingThankYouPlayerCode = playerCode;
  if (playerCode === userCode && pendingThankYouCard) {
    flyCard(document.getElementById('discard-card'), document.getElementById('my-hand'), true, pendingThankYouCard);
  }
  pendingThankYouCard = null;
  showThankYouBubble(playerCode, playerName);
});

function getPlayerEl(playerCode) {
  if (playerCode === userCode) return document.getElementById('my-character');
  if (!gameState) return null;
  const positions = ['top', 'left', 'right'];
  const others = getOtherSeats(myFixedSeat);
  for (let i = 0; i < others.length; i++) {
    if (others[i]?.userCode === playerCode) return document.getElementById(`player-${positions[i]}`);
  }
  return null;
}

function showBubble(playerCode, text) {
  const targetEl = getPlayerEl(playerCode);
  if (!targetEl) return;

  const bubble = document.createElement('div');
  bubble.textContent = text;
  bubble.className = 'thankyou-bubble';
  // 위쪽 캐릭터는 아래로, 나머지(왼쪽/나=왼쪽기준, 오른쪽=오른쪽기준)는 위로 - 화면 밖으로 안 잘리게
  if (targetEl.id === 'player-top') bubble.dataset.dir = 'below';
  else if (targetEl.id === 'player-right') bubble.dataset.dir = 'above-right';
  else bubble.dataset.dir = 'above-left';
  targetEl.style.position = 'relative';
  targetEl.appendChild(bubble);

  setTimeout(() => bubble.remove(), 2500);
}

function showThankYouBubble(playerCode, playerName) {
  showBubble(playerCode, '땡큐! 😊');
}

// ── Game Log ───────────────────────────────────────────────────────────
socket.on('gameLog', (message) => {
  if (message.includes('생각 중')) {
    addLog(message);
  } else {
    setTimeout(() => addLog(message), 450);
  }
});

function addLog(msg) {
  const log = document.getElementById('game-log');
  const el = document.createElement('div');
  el.className = 'log-entry';
  el.textContent = msg;
  log.prepend(el);
  // 최대 20줄 유지
  const maxLog = document.body.classList.contains('mobile') ? 3 : 20;
  while (log.children.length > maxLog) log.removeChild(log.lastChild);
}

// ── Dealing Animation ──────────────────────────────────────────────────
function showDealingAnimation() {
  const overlay = document.createElement('div');
  overlay.id = 'dealing-overlay';
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:500;display:flex;align-items:center;justify-content:center;pointer-events:none;';
  const txt = document.createElement('div');
  txt.style.cssText = 'color:#f0b90b;font-size:20px;font-weight:bold;letter-spacing:2px;';
  txt.textContent = '카드 배분 중...';
  overlay.appendChild(txt);
  document.body.appendChild(overlay);
  // 카드 배분 느낌으로 0.7초 간격으로 7번 깜빡
  let cnt = 0;
  const iv = setInterval(() => {
    txt.style.opacity = cnt % 2 === 0 ? '0.4' : '1';
    cnt++;
    if (cnt > 14) {
      clearInterval(iv);
      overlay.remove();
    }
  }, 100);
  setTimeout(() => overlay.remove(), 1500);
}

// ── Notifications ──────────────────────────────────────────────────────
function showNotif(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `notif ${type}`;
  el.textContent = msg;
  document.getElementById('notifications').appendChild(el);
  setTimeout(() => el.remove(), 2500);
}
