const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const db = require('./db/database');
const {
  createGame, getCurrentPlayer, getPublicState,
  drawCard, registerCards, attachCards, discardCard,
  autoTimeout, nextTurn,
  tryThankYou, confirmThankYou, cancelThankYou, cancelConfirmedThankYou, activateThankYou,
  calculateResults
} = require('./game/gameEngine');
const { decideDraw, decideActions, decideAttach, decideDiscard, isCardUseful, findCombos } = require('./game/aiPlayer');
const { canAttach, cardName } = require('./game/cardUtils');
const { getUserCount } = require('./db/database');
const statsUtils = require('./game/statsUtils');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const sessions = new Map();
// 방(room) 시스템: 서버 전체에 여러 방이 동시에 존재 가능
// room = { id, title, code(선택, 없으면 잠금 없는 공개방), members: Set<userCode>,
//          game, lastGamePlayers, lastGameWinnerCode, readyPhase, createdBy }
const rooms = new Map();
let roomIdCounter = 1;
const singleGames = new Map();
const lastSingleWinners = new Map(); // userCode → 마지막 싱글 승자 userCode
const lastSingleSeating = new Map(); // userCode → 마지막 싱글게임의 좌석 순서(userCode 배열, 원래 순서 그대로)

// ── 접속중 표시 & 초대 ────────────────────────────────────────────────────
const presenceVisible = new Set(); // userCode → 탭이 보이는 중(연결+포커스)
const pendingInvites = new Map();  // fromCode → { toCode, wasPlayingSingle, roomId }
const inviteApprovedWaiting = new Map(); // userCode → { roomId, expiresAt } 페이지 이동 후 재접속용

// ── Helpers ────────────────────────────────────────────────────────────────

function getSocketId(userCode) {
  for (const [sid, s] of sessions) {
    if (s.userCode === userCode) return sid;
  }
  return null;
}

function emitToPlayer(userCode, event, data) {
  const sid = getSocketId(userCode);
  if (sid) io.to(sid).emit(event, data);
}

function broadcastGame(game) {
  for (const p of game.players) {
    if (!p.isAI) {
      emitToPlayer(p.userCode, 'gameState', getPublicState(game, p.userCode));
    }
  }
  const room = rooms.get(game.roomId);
  if (room) {
    for (const uc of room.waiters) {
      emitToPlayer(uc, 'gameState', getPublicState(game, uc));
    }
  }
}

// ── 방(room) 헬퍼 ────────────────────────────────────────────────────────────
function genRoomId() { return `room_${roomIdCounter++}`; }

// 이 유저가 지금 (대기중이든 게임중이든) 속해있는 방을 찾는다
// 재접속(로그인, 페이지 이동으로 인한 소켓 재연결 포함) 시 "원래 있던 방"을 찾을 때 사용.
// 연결이 끊겨 AI로 대체된 상태여도(예: index.html→game.html 이동 중 잠깐 끊김) 찾아내야
// 다시 사람으로 되돌릴 수 있으므로, isAI 여부와 상관없이 매칭한다.
function findRoomOfUser(userCode) {
  for (const room of rooms.values()) {
    if (room.members.has(userCode)) return room;
    if (room.waiters.has(userCode)) return room;
    if (room.game?.players.some(p => p.userCode === userCode)) return room;
    // 게임 종료 후 "한 판 더" 준비 단계: members도 비어있고 game도 null이라 lastGamePlayers로도 찾아야 함
    if (room.lastGamePlayers?.some(p => p.userCode === userCode)) return room;
  }
  return null;
}

// 초대/참가 대상으로 쓸 수 있는지: 다른 방에 대기 중이거나, 다른 방 게임에서 "현재 사람이 조종 중"이면 불가.
// 연결이 끊겨 AI로 대체된 사람은 초대 가능(자유로운 상태)으로 취급.
function isAvailableForRoom(userCode) {
  for (const room of rooms.values()) {
    if (room.members.has(userCode)) return false;
    if (room.waiters.has(userCode)) return false;
    if (room.game?.players.some(p => p.userCode === userCode && !p.isAI)) return false;
  }
  return true;
}

function roomSummary(room) {
  const playing = !!room.game && room.game.status === 'playing';
  const humanCount = playing ? room.game.players.filter(p => !p.isAI).length : room.members.size;
  return {
    id: room.id,
    title: room.title,
    locked: !!room.code,
    memberCount: humanCount,
    playing,
    waitingCount: playing ? room.waiters.size : 0,
    waitingCap: playing ? Math.max(0, 4 - humanCount) : 0,
  };
}

// 대기자 전원 이름을 방 참가자(플레이어) + 대기자 모두에게 알림 ("OOO, OOO님 대기중" 뱃지용)
// room.game이 게임 종료 직후 "한 판 더" 준비 단계에서 null이 되는 구간에도(room.lastGamePlayers로) 갱신을 보내야
// 그 구간에 대기자가 빠지거나 타임아웃될 때 뱃지가 실시간으로 사라진다.
function broadcastWaiterList(room) {
  const recipients = room.game ? room.game.players : room.lastGamePlayers;
  if (!recipients) return;
  const names = [...room.waiters].map(uc => sessions.get(getSocketId(uc))?.userName).filter(Boolean);
  const payload = { count: room.waiters.size, names };
  for (const p of recipients) {
    if (!p.isAI) emitToPlayer(p.userCode, 'waiterList', payload);
  }
  for (const uc of room.waiters) emitToPlayer(uc, 'waiterList', payload);
}

function broadcastRoomList() {
  const list = [...rooms.values()].map(roomSummary);
  io.emit('roomList', { rooms: list });
}

// 대기자 연결이 끊기면 즉시 내보내지 않고 잠깐 유예를 둔다 —
// index.html → game.html 페이지 이동 자체가 소켓 재연결(짧은 순간의 disconnect)을 일으키기 때문에,
// 유예 없이 바로 내보내면 정상적으로 관전 화면에 들어가려던 사람까지 쫓겨나 버림.
const WAITER_LEAVE_GRACE_MS = 6000;
function scheduleWaiterLeave(room, userCode) {
  const existing = room.waiterLeaveTimers.get(userCode);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    room.waiterLeaveTimers.delete(userCode);
    if (!room.waiters.has(userCode)) return;
    room.waiters.delete(userCode);
    if (room.readyPhase) {
      room.readyPhase.requiredCodes.delete(userCode);
      room.readyPhase.readyCodes.delete(userCode);
      room.readyPhase.deadlines.delete(userCode);
      room.readyPhase.timers.delete(userCode);
    }
    broadcastWaiterList(room);
    broadcastRoomList();
    checkAndCloseIfAlone(room);
  }, WAITER_LEAVE_GRACE_MS);
  room.waiterLeaveTimers.set(userCode, t);
}
function cancelWaiterLeave(room, userCode) {
  const t = room.waiterLeaveTimers.get(userCode);
  if (t) { clearTimeout(t); room.waiterLeaveTimers.delete(userCode); }
}

// 게임 종료 후 "한 판 더" 준비 단계에서, 온라인 인원(기존 참가자+대기자)이 1명 이하로 줄면
// 남은 사람도 메인으로 돌려보내고 방을 정리한다. startReadyPhase 최초 진입 시 + 준비 단계 중
// 누군가 연결이 끊길 때마다 재검사한다.
function checkAndCloseIfAlone(room) {
  if (!room.lastGamePlayers || room.game) return false;
  const onlineHumans = room.lastGamePlayers.filter(p => !p.isAI && getSocketId(p.userCode));
  const onlineWaiters = [...room.waiters].filter(uc => getSocketId(uc));
  if (onlineHumans.length + onlineWaiters.length > 1) return false;
  for (const p of onlineHumans) emitToPlayer(p.userCode, 'playAgainError', '함께할 사람이 없어 메인으로 돌아갑니다.');
  for (const uc of onlineWaiters) emitToPlayer(uc, 'playAgainError', '함께할 사람이 없어 메인으로 돌아갑니다.');
  if (room.readyPhase) { for (const t of room.readyPhase.timers.values()) clearTimeout(t); }
  for (const t of room.waiterLeaveTimers.values()) clearTimeout(t);
  rooms.delete(room.id);
  broadcastRoomList();
  return true;
}

async function broadcastRoomWaiting(room) {
  const badges = await getGlobalBadges();
  const players = [];
  for (const uc of room.members) {
    const u = await db.getUser(uc);
    if (u) players.push({
      userCode: u.userCode, userName: u.userName, isAdmin: u.isAdmin === 1,
      isHost: uc === room.createdBy, ready: uc === room.createdBy || room.readyMembers.has(uc),
      ...badgeFlagsFor(u.userCode, badges)
    });
  }
  const allReady = [...room.members].filter(uc => uc !== room.createdBy).every(uc => room.readyMembers.has(uc));
  const payload = { id: room.id, title: room.title, locked: !!room.code, code: room.code || null, hostCode: room.createdBy, allReady, players };
  for (const uc of room.members) emitToPlayer(uc, 'roomWaiting', payload);
}

// 게임 시작 전, 누구 하나라도 명시적으로 나가면 방 자체를 없앤다 (남은 사람도 로비로 돌아감)
function closeRoom(room, reason) {
  if (room.readyPhase) { for (const t of room.readyPhase.timers.values()) clearTimeout(t); }
  for (const uc of [...room.members, ...room.waiters]) {
    const sid = getSocketId(uc);
    const s = sid && sessions.get(sid);
    if (s) s.roomId = null;
    emitToPlayer(uc, 'roomClosed', { reason });
  }
  rooms.delete(room.id);
  broadcastRoomList();
}

// 연결 끊김(네트워크 문제 등) 때는 방을 없애지 않고 그 사람만 빠진 걸로 처리 (재접속 여지를 둠)
function removeMemberFromRoom(room, userCode) {
  room.members.delete(userCode);
  const stillHasHumans = room.members.size > 0 || (room.game?.status === 'playing' && room.game.players.some(p => !p.isAI));
  if (!stillHasHumans) {
    if (room.readyPhase) { for (const t of room.readyPhase.timers.values()) clearTimeout(t); }
    for (const uc of room.waiters) {
      const sid = getSocketId(uc);
      const s = sid && sessions.get(sid);
      if (s) s.roomId = null;
      emitToPlayer(uc, 'roomClosed', { reason: '방이 사라졌어요' });
    }
    rooms.delete(room.id);
  }
  broadcastRoomList();
}

// ── 접속중 표시 ────────────────────────────────────────────────────────────
function visibleOnlineCodes() {
  const out = [];
  for (const uc of presenceVisible) {
    const sid = getSocketId(uc);
    const sess = sid && sessions.get(sid);
    if (sess && sess.showOnline !== false) out.push(uc);
  }
  return out;
}

// 상호차단: 내가 표시를 끄면 나도 남 상태를 못 봄. 단, 관리자는 초대 기능 때문에 예외로 항상 봄.
function broadcastPresence() {
  const online = visibleOnlineCodes();
  for (const [sid, sess] of sessions) {
    const canSee = sess.isAdmin || sess.showOnline !== false;
    io.to(sid).emit('presenceList', { online: canSee ? online : [] });
  }
}

// ── 뱃지(👑싱글1위/💎멀티1위/훌라왕) ──────────────────────────────────────────
// 게임 화면은 game.rank1Single/rank1Multi/hulaKingCode 스냅샷(snapshotRank1)을 쓰고,
// 로비류 화면(메인/설정/대기실 등)은 매번 최신값을 여기서 조회해서 붙인다.
async function getGlobalBadges() {
  const [singleRanking, multiRanking, hulaRanking] = await Promise.all([
    db.getSingleRanking(), db.getMultiRanking(), db.getHulaRanking()
  ]);
  return {
    rank1Single: singleRanking[0]?.userCode ?? null,
    rank1Multi: multiRanking[0]?.userCode ?? null,
    hulaKing: hulaRanking[0]?.userCode ?? null
  };
}
function badgeFlagsFor(userCode, badges) {
  return {
    isRank1Single: !!badges.rank1Single && userCode === badges.rank1Single,
    isRank1Multi: !!badges.rank1Multi && userCode === badges.rank1Multi,
    isHulaKing: !!badges.hulaKing && userCode === badges.hulaKing
  };
}

// 초대 때문에 자동 일시정지된 싱글 게임을 원상복구 (거절/취소/연결끊김 시 호출)
function resumeIfInvitePaused(userCode) {
  const g = singleGames.get(userCode);
  if (!g || !g.paused || g.pausedReason !== 'invite') return;
  g.paused = false;
  g.pausedReason = null;
  const remaining = g.timerRemainingMs ?? 45000;
  g.timerRemainingMs = null;
  broadcastGame(g);
  const cur = getCurrentPlayer(g);
  startTimer(g, remaining);
  if (cur?.isAI) setTimeout(() => runAITurn(g, cur), 2000 + Math.random() * 1000);
}

// userCode가 얽힌 대기 중인 초대를 정리한다: 내가 보낸 초대는 취소, 나한테 온 초대는 상대에게 취소 알림.
// disconnect뿐 아니라 중복 로그인으로 옛 소켓을 강제 종료할 때도 호출해야 함 — 그 경로는
// disconnect 이벤트가 오기 전에 세션을 먼저 지워버려서 여기 정리가 누락되면 pendingInvites가
// 영원히 안 지워진 채 남아 "이미 다른 초대가 진행 중이에요" 오류를 계속 일으킴.
function cancelInvitesFor(userCode) {
  for (const [key, inv] of [...pendingInvites]) {
    if (inv.fromCode === userCode) {
      pendingInvites.delete(key);
      resumeIfInvitePaused(inv.toCode);
      emitToPlayer(inv.toCode, 'inviteCancelled', {});
    } else if (inv.toCode === userCode) {
      pendingInvites.delete(key);
      emitToPlayer(inv.fromCode, 'inviteCancelled', {});
    }
  }
}

// ── 멀티모드 "한 판 더" 준비 단계 (방 단위) ─────────────────────────────────
const READY_TIMEOUT_MS = 30000;

function clearReadyPhase(room) {
  if (room.readyPhase) {
    for (const t of room.readyPhase.timers.values()) clearTimeout(t);
  }
  room.readyPhase = null;
}

function broadcastReadyStatus(room) {
  if (!room.readyPhase || !room.lastGamePlayers) return;
  const payload = {
    requiredCodes: [...room.readyPhase.requiredCodes],
    readyCodes: [...room.readyPhase.readyCodes],
    deadlines: Object.fromEntries(room.readyPhase.deadlines),
  };
  for (const p of room.lastGamePlayers) {
    if (!p.isAI) emitToPlayer(p.userCode, 'readyStatus', payload);
  }
  for (const uc of room.waiters) emitToPlayer(uc, 'readyStatus', payload);
}

// 대기자가 준비 시간 내 응답 없으면(기존 멤버와 달리) 자동 준비 처리 대신 대기 자체를 취소
function dropWaiterOnTimeout(room, userCode) {
  room.waiters.delete(userCode);
  if (room.readyPhase) {
    room.readyPhase.requiredCodes.delete(userCode);
    room.readyPhase.readyCodes.delete(userCode);
    room.readyPhase.deadlines.delete(userCode);
    room.readyPhase.timers.delete(userCode);
  }
  emitToPlayer(userCode, 'playAgainError', '준비 시간이 지나 대기가 취소됐습니다.');
  broadcastWaiterList(room);
  broadcastRoomList();
  if (checkAndCloseIfAlone(room)) return;
  broadcastReadyStatus(room);
}

// userCode가 속한 방의 readyPhase에서 준비 완료 표시
function markReady(userCode) {
  const room = findRoomOfUser(userCode);
  if (!room?.readyPhase || !room.readyPhase.requiredCodes.has(userCode)) return;
  if (room.readyPhase.readyCodes.has(userCode)) return;
  room.readyPhase.readyCodes.add(userCode);
  const t = room.readyPhase.timers.get(userCode);
  if (t) clearTimeout(t);
  room.readyPhase.timers.delete(userCode);
  broadcastReadyStatus(room);
}

// 멀티모드 게임 종료 직후 호출: 해당 방에 다음 판 "준비" 단계를 세팅한다.
// 실제 사람이 혼자(또는 0명)만 남았으면 준비 단계 없이 메인으로 안내.
async function startReadyPhase(room) {
  clearReadyPhase(room);
  if (!room.lastGamePlayers) return;

  if (checkAndCloseIfAlone(room)) return;
  const onlineHumans = room.lastGamePlayers.filter(p => !p.isAI && getSocketId(p.userCode));

  // 방장은 "다시 시작" 버튼을 직접 누르는 쪽이라 준비 대상에서 제외, 나머지(기존 인원+대기자)는 준비 확인
  const waiterCodes = [...room.waiters].filter(uc => getSocketId(uc));
  const requiredCodes = new Set([
    ...onlineHumans.filter(p => p.userCode !== room.createdBy).map(p => p.userCode),
    ...waiterCodes.filter(uc => uc !== room.createdBy),
  ]);

  room.readyPhase = { requiredCodes, readyCodes: new Set(), deadlines: new Map(), timers: new Map() };
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (const code of requiredCodes) {
    room.readyPhase.deadlines.set(code, deadline);
    // 원래 있던 인원은 응답 없으면 자동 준비 처리, 대기자는 응답 없으면 자동으로 대기 이탈
    const isWaiter = room.waiters.has(code);
    room.readyPhase.timers.set(code, setTimeout(() => {
      if (isWaiter) dropWaiterOnTimeout(room, code);
      else markReady(code);
    }, READY_TIMEOUT_MS));
  }

  broadcastReadyStatus(room);
}

const DOUBLE_EVENT_CHANCE = 0.1; // 깜짝 2배 이벤트 판 확률

// 게임 시작 시점의 전역 1위(싱글 포인트 / 멀티 잔액 / 훌라왕)를 스냅샷으로 저장 (뱃지 판단용),
// 동시에 이번 판이 "2배 이벤트 판"인지도 여기서 함께 굴림 (매 게임 생성 시 한 번만)
async function snapshotRank1(game) {
  const [singleRanking, multiRanking, hulaRanking] = await Promise.all([
    db.getSingleRanking(), db.getMultiRanking(), db.getHulaRanking()
  ]);
  game.rank1Single = singleRanking[0]?.userCode ?? null;
  game.rank1Multi = multiRanking[0]?.userCode ?? null;
  game.hulaKingCode = hulaRanking[0]?.userCode ?? null;
  game.isDoubleEvent = Math.random() < DOUBLE_EVENT_CHANCE;
}

// ── Timer ──────────────────────────────────────────────────────────────────

function startTimer(game, durationMs = 45000) {
  clearTimer(game);
  game.timerStart = Date.now();
  game.timer = setTimeout(() => handleTimeout(game), durationMs);
}

function clearTimer(game) {
  if (game.timer) { clearTimeout(game.timer); game.timer = null; }
}

// 게임 시작 첫 턴: 2배 이벤트 판이면 클라이언트가 "⚡2배 이벤트⚡" 오버레이(3초)를 다 보여줄 때까지
// 타이머/AI 턴을 미뤄서, 오버레이 보는 동안 시간이 깎이지 않게 한다.
function startInitialTurn(game, cur, aiDelayMs) {
  const delay = game.isDoubleEvent ? 3000 : 0;
  setTimeout(() => {
    if (game.status !== 'playing' || game.paused) return;
    startTimer(game);
    if (cur.isAI) setTimeout(() => runAITurn(game, cur), aiDelayMs);
  }, delay);
}

function handleTimeout(game) {
  if (game.paused) return;
  const player = getCurrentPlayer(game);
  if (!player || player.isAI) return;

  // 땡큐 테이커가 시간 초과 → 자동 취소 + 벌금
  if (game.thankYouTaker === player.userCode) {
    const takerCode = player.userCode;
    const result = cancelConfirmedThankYou(game, takerCode);
    if (!result.ok) return;

    const unit = game.mode === 'multi' ? 100 : 1;
    const others = game.players.filter(p => p.userCode !== takerCode);
    const penalty = unit * others.length;

    for (const p of game.players) {
      if (!p.isAI) emitToPlayer(p.userCode, 'thankYouCancelled', { cancellerCode: takerCode, penalty, gain: unit, auto: true });
    }

    setTimeout(() => {
      broadcastGame(game);
      const cur = getCurrentPlayer(game);
      startTimer(game);
      if (cur?.isAI) setTimeout(() => runAITurn(game, cur), 2000 + Math.random() * 1000);
    }, 1200);

    // 정산 때 반영 (pendingChanges에 기록)
    game.pendingChanges[takerCode] = (game.pendingChanges[takerCode] || 0) - penalty;
    for (const p of others) {
      game.pendingChanges[p.userCode] = (game.pendingChanges[p.userCode] || 0) + unit;
    }
    return;
  }

  const result = autoTimeout(game);
  if (result.deckEmpty) { setTimeout(() => endGame(game, null), 3000); return; }

  broadcastGame(game);
  if (game.lastDeckDraw) { game.lastDeckDraw = false; setTimeout(() => endGame(game, null), 3000); return; }
  activateThankYouWindow(game, result.discardedCard);
}

// ── Thank You Window ───────────────────────────────────────────────────────

function activateThankYouWindow(game, card) {
  clearThankYouTimeout(game);
  // 버린 사람(현재 플레이어)을 기록한 뒤 턴 넘김
  const discarderCode = getCurrentPlayer(game)?.userCode;
  activateThankYou(game, card, discarderCode);

  // 살짝 텀 후 다음 턴으로 전환 (카드 버리는 애니메이션 여운)
  nextTurn(game);

  setTimeout(() => {
    broadcastGame(game);
    if (game.paused) return;

    const cur = getCurrentPlayer(game);
    if (!cur) return;
    broadcastLog(game, `${cur.userName} 생각 중...`);
    startTimer(game);

    // 현재 플레이어·버린 플레이어 제외한 다른 AI가 땡큐 고려 (1.5~4초 랜덤 대기 후, 그 시점에 판단)
    const windowCard = game.thankYou.card; // 이 창이 열릴 때의 카드 (늦게 발동돼도 다른 창의 카드로 오판하지 않도록 고정)
    for (const p of game.players) {
      if (!p.isAI || p.userCode === cur.userCode || p.userCode === discarderCode) continue;
      const d = [1500, 2000, 3000, 4000][Math.floor(Math.random() * 4)];
      setTimeout(() => {
        if (!game.thankYou.active || game.thankYou.card !== windowCard || game.thankYou.lock || game.paused) return;
        const card = game.thankYou.card;
        const useful = isCardUseful(card, p.hand, game.combos, p.registered);
        if (!useful) return;
        // 진단 로그: 나중에 자동취소 로그와 대조해서 결정시점↔사용시점 상태 차이 추적용
        console.log('[땡큐결정 진단]', JSON.stringify({
          player: p.userName,
          userCode: p.userCode,
          card: cardName(card),
          registered: p.registered,
          handBefore: p.hand.map(cardName),
          existingCombos: game.combos.map(c => ({ id: c.id, type: c.type, cards: c.cards.map(cardName) })),
        }));
        const r = tryThankYou(game, p.userCode);
        if (r.ok) {
          const cty = confirmThankYou(game, p.userCode);
          broadcastThankYouAnnounce(game, p.userCode, p.userName, cty.card);
          setTimeout(() => {
            broadcastGame(game);
            startTimer(game);
            setTimeout(() => runAITurn(game, p), 2000 + Math.random() * 1000);
          }, 600);
        }
      }, d);
    }

    // 현재 플레이어가 AI면 드로우 (2~5초 랜덤 → 땡큐와 타이밍 겹침)
    if (cur.isAI) {
      setTimeout(() => runAITurn(game, cur), 2000 + Math.random() * 3000);
    }
  }, 600);
}

function clearThankYouTimeout(game) {
  if (game.thankYouTimeout) { clearTimeout(game.thankYouTimeout); game.thankYouTimeout = null; }
}

// ── Turn Advancement ───────────────────────────────────────────────────────

function advanceTurn(game, winnerCode = null) {
  clearThankYouTimeout(game);
  nextTurn(game, winnerCode);
  broadcastGame(game);
  const cur = getCurrentPlayer(game);
  if (!cur) return;
  broadcastLog(game, `${cur.userName} 생각 중...`);
  if (cur.isAI) {
    startTimer(game);
    setTimeout(() => runAITurn(game, cur), 1500 + Math.random() * 1500);
  } else {
    startTimer(game);
  }
}

// ── AI Turn ────────────────────────────────────────────────────────────────

function isCurrentPlayer(game, aiPlayer) {
  return getCurrentPlayer(game)?.userCode === aiPlayer.userCode;
}

async function runAITurn(game, aiPlayer) {
  if (game.status !== 'playing') return;
  if (game.paused) return;
  if (!isCurrentPlayer(game, aiPlayer)) return;
  if (!aiPlayer.isAI) return;

  if (game.phase === 'draw') {
    // 땡큐 활성 중이거나 버린더미 hidden이면 덱에서만 드로우 가능
    const discardTop = (game.thankYou.active || game.discardPileHidden) ? null :
      (game.discardPile.length > 0 ? game.discardPile[game.discardPile.length - 1] : null);
    const drawSrc = (!game.firstTurn && discardTop && decideDraw(aiPlayer.hand, discardTop) === 'discard') ? 'discard' : 'deck';

    if (game.deck.length === 0 && drawSrc === 'deck') { endGame(game, null); return; }

    // 생각 중 사이에 다른 사람이 땡큐해서 턴이 바뀌었으면 종료
    if (!isCurrentPlayer(game, aiPlayer)) return;

    const dr0 = drawCard(game, aiPlayer.userCode, drawSrc);
    if (!dr0.ok) return;
    broadcastLog(game, `${aiPlayer.userName} ${drawSrc === 'discard' ? '버린 더미' : '카드 더미'}에서 드로우`);
    broadcastGame(game);
    if (game.lastDeckDraw) {
      for (const p of game.players) {
        if (!p.isAI) emitToPlayer(p.userCode, 'deckEmpty', {});
      }
    }
    await sleep(500 + Math.random() * 500);
    // 드로우 후 대기 중 다른 사람이 땡큐해서 턴이 넘어갔으면 여기서 종료 (등록/붙이기/버리기 진행 안 함)
    if (!isCurrentPlayer(game, aiPlayer)) return;
  }

  // 땡큐 테이커: 가져온 카드를 반드시 먼저 사용
  if (game.thankYouTaker === aiPlayer.userCode && game.thankYouTakerCard) {
    const takerCard = game.thankYouTakerCard;
    if (aiPlayer.hand.some(c => c.id === takerCard.id)) {
      // 1. 땡큐 카드 포함한 조합 등록 시도 (여러 개 걸리면 가장 큰 조합 선택 — 예: 6-7 2장짜리보다 6-7-8 3장짜리 우선)
      const combos = findCombos(aiPlayer.hand);
      const combosWithCard = combos.filter(cb => cb.cards.some(c => c.id === takerCard.id));
      const comboWithCard = combosWithCard.length
        ? combosWithCard.reduce((a, b) => b.cards.length > a.cards.length ? b : a)
        : null;
      if (comboWithCard) {
        const r = registerCards(game, aiPlayer.userCode, comboWithCard.cards.map(c => c.id));
        broadcastLog(game, `${aiPlayer.userName} 등록: [${r.combo.cards.map(cardName).join(', ')}]`);
        if (r.win) { broadcastGame(game); await sleep(800); endGame(game, aiPlayer.userCode); return; }
        broadcastGame(game);
        await sleep(500);
      } else {
        // 2. 기존 조합에 붙이기 시도
        let attached = false;
        const attachAttempts = [];
        for (const combo of game.combos) {
          if (canAttach(combo, takerCard)) {
            const r = attachCards(game, aiPlayer.userCode, [takerCard.id], combo.id);
            attachAttempts.push({ comboId: combo.id, comboType: combo.type, result: r.ok ? 'ok' : (r.msg || 'fail') });
            if (r.ok) {
              broadcastLog(game, `${aiPlayer.userName} 붙이기: [${cardName(takerCard)}]`);
              if (r.win) { broadcastGame(game); await sleep(800); endGame(game, aiPlayer.userCode); return; }
              broadcastGame(game);
              await sleep(400);
              attached = true;
              break;
            }
          }
        }
        if (!attached) {
          // 진단 로그: 왜 자동취소로 빠졌는지 원인 추적용
          console.log('[땡큐취소 진단]', JSON.stringify({
            player: aiPlayer.userName,
            userCode: aiPlayer.userCode,
            takerCard: cardName(takerCard),
            registered: aiPlayer.registered,
            hand: aiPlayer.hand.map(cardName),
            existingCombos: game.combos.map(c => ({ id: c.id, type: c.type, cards: c.cards.map(cardName) })),
            comboWithCardFound: false,
            attachAttempts,
          }));
          // 3. 못 쓰면 자동 취소 + 벌금
          const cres = cancelConfirmedThankYou(game, aiPlayer.userCode);
          if (cres.ok) {
            const unit = game.mode === 'multi' ? 100 : 1;
            const others = game.players.filter(p => p.userCode !== aiPlayer.userCode);
            const penalty = unit * others.length;
            game.pendingChanges[aiPlayer.userCode] = (game.pendingChanges[aiPlayer.userCode] || 0) - penalty;
            for (const p of others) {
              game.pendingChanges[p.userCode] = (game.pendingChanges[p.userCode] || 0) + unit;
            }
            // 클라이언트에 취소 알림 (말풍선용)
            for (const p of game.players) {
              if (!p.isAI) emitToPlayer(p.userCode, 'thankYouCancelled', { cancellerCode: aiPlayer.userCode, penalty, gain: unit });
            }
            broadcastLog(game, `${aiPlayer.userName} 땡큐 취소 (벌금 부과)`);
            setTimeout(() => {
              broadcastGame(game);
              const cur = getCurrentPlayer(game);
              startTimer(game);
              if (cur?.isAI) setTimeout(() => runAITurn(game, cur), 2000 + Math.random() * 1000);
            }, 1200);
          }
          return;
        }
      }
    }
  }

  if (!isCurrentPlayer(game, aiPlayer)) return;

  const actions = decideActions(aiPlayer.hand, game.combos, aiPlayer.registered);
  for (const action of actions) {
    if (action.type === 'register') {
      if (!isCurrentPlayer(game, aiPlayer)) return;
      const r = registerCards(game, aiPlayer.userCode, action.cards.map(c => c.id));
      if (!r.ok) return;
      broadcastLog(game, `${aiPlayer.userName} 등록: [${r.combo.cards.map(cardName).join(', ')}]`);
      if (r.win) { broadcastGame(game); await sleep(800); endGame(game, aiPlayer.userCode); return; }
      broadcastGame(game);
      await sleep(500);
    }
  }

  if (!isCurrentPlayer(game, aiPlayer)) return;

  if (aiPlayer.registered) {
    let didAttach = true;
    while (didAttach) {
      didAttach = false;
      const attaches = decideAttach(aiPlayer.hand, game.combos, true);
      for (const a of attaches) {
        if (!isCurrentPlayer(game, aiPlayer)) return;
        const r = attachCards(game, aiPlayer.userCode, [a.card.id], a.comboId);
        if (!r.ok) continue;
        didAttach = true;
        broadcastLog(game, `${aiPlayer.userName} 붙이기: [${cardName(a.card)}]`);
        if (r.win) { broadcastGame(game); await sleep(800); endGame(game, aiPlayer.userCode); return; }
        broadcastGame(game);
        await sleep(400);
      }
    }
  }

  if (!isCurrentPlayer(game, aiPlayer)) return;

  await sleep(400 + Math.random() * 300);

  if (!isCurrentPlayer(game, aiPlayer)) return;

  const cardToDiscard = decideDiscard(aiPlayer.hand, game.combos, game.discardPile);
  if (!cardToDiscard) return; // 패가 비었으면 이미 승리 처리 중
  const dr = discardCard(game, aiPlayer.userCode, cardToDiscard.id);
  if (!dr.ok) return;

  broadcastLog(game, `${aiPlayer.userName} 카드 버림`);
  clearTimer(game);
  if (dr.win) { broadcastGame(game); await sleep(800); endGame(game, aiPlayer.userCode); return; }
  if (game.lastDeckDraw) { game.lastDeckDraw = false; broadcastGame(game); await sleep(3000); endGame(game, null); return; }
  activateThankYouWindow(game, dr.card);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function broadcastLog(game, message) {
  for (const p of game.players) {
    if (!p.isAI) emitToPlayer(p.userCode, 'gameLog', message);
  }
}

function broadcastThankYouAnnounce(game, playerCode, playerName, card) {
  const suitKo = { S: '스페이드', H: '하트', D: '다이아', C: '클로버' }[card?.suit] || '';
  const valStr = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' }[card?.value] || String(card?.value || '');
  const cardStr = card ? `${valStr}(${suitKo})` : '';
  broadcastLog(game, `${playerName}가 땡큐해서 카드 ${cardStr} 가져감`);
  for (const p of game.players) {
    if (!p.isAI) emitToPlayer(p.userCode, 'thankYouAnnounce', { playerCode, playerName });
  }
}

// ── Game End ───────────────────────────────────────────────────────────────

async function endGame(game, winnerCode) {
  if (game.status === 'ended') return;
  clearTimer(game);
  clearThankYouTimeout(game);
  game.status = 'ended';

  const isHula = !!winnerCode && game.hulaWinnerCode === winnerCode;
  game.hulaWinnerCode = null;

  const results = calculateResults(game, winnerCode, isHula, game.isDoubleEvent);
  // 실제 1등(덱 소진 시에도 포함)을 다음 판 선공 결정에 활용
  const actualWinnerCode = results.find(r => r.rank === 1)?.userCode || null;

  const continuedFlag = game.mode === 'single' ? !!game.continuedFromPrevious : null;
  await db.saveGameResult(game.id, game.mode, results, isHula, continuedFlag);
  // 방금 훌라로 이겼으면 훌라왕이 바로 갱신됐을 수 있음 — 정산 화면에 즉시 반영
  const hulaRanking = await db.getHulaRanking();
  game.hulaKingCode = hulaRanking[0]?.userCode ?? null;

  // "새로 1위 등극" 판단: 게임 시작 시점 1위 스냅샷과 게임 종료 후 최신 랭킹을 비교
  // + 게임판(뒤에 깔린 캐릭터 뱃지)도 최신 1위로 즉시 갱신
  let newRank1 = null; // 'single' | 'multi' | null
  if (game.mode === 'single') {
    const ranking = await db.getSingleRanking();
    const prevRank1 = game.rank1Single;
    game.rank1Single = ranking[0]?.userCode ?? null;
    if (actualWinnerCode && game.rank1Single === actualWinnerCode && prevRank1 !== actualWinnerCode) {
      const winner = game.players.find(p => p.userCode === actualWinnerCode);
      if (winner && !winner.isAI) newRank1 = 'single';
    }
  } else {
    const ranking = await db.getMultiRanking();
    const prevRank1 = game.rank1Multi;
    game.rank1Multi = ranking[0]?.userCode ?? null;
    if (actualWinnerCode && game.rank1Multi === actualWinnerCode && prevRank1 !== actualWinnerCode) {
      const winner = game.players.find(p => p.userCode === actualWinnerCode);
      if (winner && !winner.isAI) newRank1 = 'multi';
    }
  }
  broadcastGame(game); // 뱃지 갱신을 승리 문구 뜨는 시점에 즉시 반영

  for (const r of results) {
    if (!r.isAI) {
      const user = await db.getUser(r.userCode);
      r.currentBalance = game.mode === 'multi' ? user?.multiBalance : user?.singlePoints;
      r.totalWins = game.mode === 'multi' ? (user?.multiWins ?? 0) : (user?.singleWins ?? 0);
      r.totalGames = game.mode === 'multi' ? (user?.multiGames ?? 0) : (user?.singleGames ?? 0);
    }
    r.isRank1Single = !r.isAI && !!game.rank1Single && r.userCode === game.rank1Single;
    r.isRank1Multi = !r.isAI && !!game.rank1Multi && r.userCode === game.rank1Multi;
    r.isHulaKing = !r.isAI && !!game.hulaKingCode && r.userCode === game.hulaKingCode;
  }

  const winnerName = results.find(r => r.rank === 1)?.userName;
  const winnerUser = actualWinnerCode ? await db.getUser(actualWinnerCode) : null;
  const winMessage = winnerUser?.winMessage || null;

  const gameEndPayload = {
    results, winnerCode: actualWinnerCode, winnerName, winMessage, newRank1, isHula,
    isDoubleEvent: !!game.isDoubleEvent
  };
  for (const p of game.players) {
    if (!p.isAI) emitToPlayer(p.userCode, 'gameEnd', gameEndPayload);
  }
  // 대기(관전) 중이던 사람들도 결과 화면을 보고 이어서 "준비" 버튼을 누를 수 있어야 함
  const waiterRoom = rooms.get(game.roomId);
  if (waiterRoom) {
    for (const uc of waiterRoom.waiters) emitToPlayer(uc, 'gameEnd', gameEndPayload);
  }

  if (game.mode === 'single') {
    const humanPlayer = game.players.find(p => !p.isAI);
    if (humanPlayer) {
      lastSingleWinners.set(humanPlayer.userCode, actualWinnerCode);
      lastSingleSeating.set(humanPlayer.userCode, game.players.map(p => p.userCode));
      singleGames.delete(humanPlayer.userCode);
    }
  } else {
    // 잔액 0 이하인 플레이어 퇴장 처리
    for (const p of game.players) {
      if (p.isAI) continue;
      const user = await db.getUser(p.userCode);
      if (user && user.multiBalance <= 0) {
        setTimeout(() => emitToPlayer(p.userCode, 'multiKicked', {}), 3000);
      }
    }

    const room = rooms.get(game.roomId);
    if (room) {
      room.lastGamePlayers = game.players.map(p => ({
        userCode: p.userCode, userName: p.userName, isAI: p.isAI, avatar: p.avatar
      }));
      room.lastGameWinnerCode = actualWinnerCode;
      room.game = null;
      broadcastRoomList();
      await startReadyPhase(room);
    }
  }
}

// ── Socket.io ──────────────────────────────────────────────────────────────

io.on('connection', (socket) => {

  socket.on('login', async ({ userCode }) => {
    const user = await db.getUser(userCode);
    if (!user) { socket.emit('loginError', '등록되지 않은 코드입니다.'); return; }

    // 같은 계정으로 이미 로그인된 소켓이 있으면 기존 소켓 강제 종료
    // (index.html → game.html 페이지 이동 시에도 새 소켓이 먼저 로그인하며 이 경로를 탈 수 있음)
    for (const [oldSid, sess] of sessions) {
      if (sess.userCode === user.userCode && oldSid !== socket.id) {
        io.to(oldSid).emit('duplicateLogin');
        io.sockets.sockets.get(oldSid)?.disconnect(true);
        sessions.delete(oldSid);
        // disconnect 이벤트는 세션이 이미 지워진 뒤 도착해 정리 로직이 스킵되므로 여기서 대신 처리
        cancelInvitesFor(user.userCode);
        break;
      }
    }

    const sess = { userCode: user.userCode, userName: user.userName, showOnline: user.showOnline !== 0, isAdmin: user.isAdmin === 1, roomId: null };
    sessions.set(socket.id, sess);
    const myBadges = badgeFlagsFor(user.userCode, await getGlobalBadges());
    socket.emit('loginSuccess', {
      userCode: user.userCode, userName: user.userName,
      isAdmin: user.isAdmin === 1,
      singlePoints: user.singlePoints, multiBalance: user.multiBalance,
      winMessage: user.winMessage, avatar: user.avatar || 'person',
      showOnline: user.showOnline !== 0,
      ...myBadges
    });
    // 멀티 방 재연결: 싱글보다 멀티 우선
    const myRoom = findRoomOfUser(user.userCode);
    if (myRoom) {
      sess.roomId = myRoom.id;
      if (myRoom.game && myRoom.game.status === 'playing') {
        const player = myRoom.game.players.find(p => p.userCode === user.userCode);
        if (player) {
          player.isAI = false;
          socket.emit('gameState', getPublicState(myRoom.game, user.userCode));
          return;
        }
        if (myRoom.waiters.has(user.userCode)) {
          cancelWaiterLeave(myRoom, user.userCode);
          socket.emit('gameState', getPublicState(myRoom.game, user.userCode));
          socket.emit('spectateOk', { roomId: myRoom.id });
          broadcastWaiterList(myRoom); // 재접속한 이 소켓에도 현재 대기자 명단을 다시 보내줌
          return;
        }
      } else if (myRoom.waiters.has(user.userCode)) {
        // "한 판 더" 준비 단계 중 대기자가 재접속한 경우 — 유예 취소만 하고 그대로 둠
        // (게임 화면에서 결과창을 계속 보고 있는 상태이므로 별도 화면 전환 불필요)
        cancelWaiterLeave(myRoom, user.userCode);
      } else if (!myRoom.lastGamePlayers) {
        broadcastRoomWaiting(myRoom);
        return;
      }
    }
    // 싱글 게임 재연결
    const existingSingle = singleGames.get(user.userCode);
    if (existingSingle && existingSingle.status === 'playing') {
      socket.emit('gameState', getPublicState(existingSingle, user.userCode));
    }
  });

  socket.on('adminLogin', async ({ password }) => {
    const stored = await db.getSetting('adminPassword');
    socket.emit('adminLoginResult', { ok: password === stored });
  });

  socket.on('adminGetUsers', async () => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    const me = await db.getUser(sess.userCode);
    if (!me?.isAdmin) return;
    socket.emit('adminUsers', await db.getAllUsers());
  });

  socket.on('adminSaveUser', async ({ userCode, userName, isAdmin }) => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    const me = await db.getUser(sess.userCode);
    if (!me?.isAdmin) return;
    const existing = await db.getUser(userCode);
    if (existing) {
      await db.updateUser(userCode, { userName, isAdmin: isAdmin ? 1 : 0 });
    } else {
      const count = await getUserCount();
      if (count >= 20) { socket.emit('adminSaveUserError', '최대 20명까지 등록 가능합니다.'); return; }
      await db.createUser(userCode, userName, isAdmin ? 1 : 0);
    }
    socket.emit('adminUsers', await db.getAllUsers());
  });

  socket.on('adminDeleteUser', async ({ userCode }) => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    const me = await db.getUser(sess.userCode);
    if (!me?.isAdmin) return;
    await db.deleteUser(userCode);
    socket.emit('adminUsers', await db.getAllUsers());
  });

  socket.on('setWinMessage', async ({ message }) => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    const msg = (message || '오예!').slice(0, 20);
    await db.updateUser(sess.userCode, { winMessage: msg });
    socket.emit('winMessageSaved');
  });

  socket.on('setAvatar', async ({ avatar }) => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    await db.updateUser(sess.userCode, { avatar });
    socket.emit('avatarSaved', { avatar });
  });

  socket.on('setShowOnline', async ({ show }) => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    sess.showOnline = !!show;
    await db.updateUser(sess.userCode, { showOnline: show ? 1 : 0 });
    socket.emit('showOnlineSaved', { show: !!show });
    broadcastPresence();
  });

  socket.on('presenceVisible', () => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    presenceVisible.add(sess.userCode);
    broadcastPresence();
  });

  socket.on('presenceHidden', () => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    presenceVisible.delete(sess.userCode);
    broadcastPresence();
  });

  // ── 멀티 초대 (누구나 가능) ──────────────────────────────────────────────
  // room이 없으면(=아직 방을 안 만든 상태) 새 방을 하나 만들어서 초대한다 (랭킹 빠른초대 등)
  async function sendRoomInvite(sess, room, targetUserCode) {
    if (targetUserCode === sess.userCode) return { ok: false, msg: '자기 자신은 초대할 수 없어요' };
    if ([...pendingInvites.values()].some(v => v.toCode === targetUserCode)) {
      return { ok: false, msg: '이미 다른 초대가 진행 중이에요' };
    }
    const targetSid = getSocketId(targetUserCode);
    const online = new Set(visibleOnlineCodes());
    if (!targetSid || !online.has(targetUserCode)) return { ok: false, msg: '상대방이 접속중이 아니에요' };
    if (!isAvailableForRoom(targetUserCode)) return { ok: false, msg: '상대방이 이미 다른 방에 있어요' };
    if (room.members.size >= 4) return { ok: false, msg: '방 인원이 가득 찼어요' };

    const targetUser = await db.getUser(targetUserCode);
    if (!targetUser) return { ok: false, msg: '존재하지 않는 유저예요' };
    const me = await db.getUser(sess.userCode);

    const targetSingle = singleGames.get(targetUserCode);
    const wasPlayingSingle = !!(targetSingle && targetSingle.status === 'playing' && !targetSingle.paused);
    if (wasPlayingSingle) {
      targetSingle.paused = true;
      targetSingle.pausedReason = 'invite';
      targetSingle.timerRemainingMs = targetSingle.timerStart ? Math.max(0, 45000 - (Date.now() - targetSingle.timerStart)) : 45000;
      clearTimer(targetSingle);
      clearThankYouTimeout(targetSingle);
      broadcastGame(targetSingle);
    }

    pendingInvites.set(`${sess.userCode}→${targetUserCode}`, { toCode: targetUserCode, wasPlayingSingle, roomId: room.id, fromCode: sess.userCode });
    emitToPlayer(targetUserCode, 'inviteReceived', {
      fromCode: sess.userCode, fromName: sess.userName, fromAvatar: me?.avatar || 'person', roomTitle: room.title
    });
    return { ok: true, toName: targetUser.userName, toAvatar: targetUser.avatar || 'person' };
  }

  // targetUserCode 없으면 내가 보낸 모든 초대를 취소 (여러 명 동시 초대 지원)
  socket.on('cancelInvite', ({ targetUserCode } = {}) => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    const keys = [...pendingInvites.keys()].filter(k => pendingInvites.get(k).fromCode === sess.userCode && (!targetUserCode || pendingInvites.get(k).toCode === targetUserCode));
    for (const key of keys) {
      const inv = pendingInvites.get(key);
      pendingInvites.delete(key);
      resumeIfInvitePaused(inv.toCode);
      emitToPlayer(inv.toCode, 'inviteCancelled', {});
    }
  });

  socket.on('respondInvite', async ({ accept, fromCode } = {}) => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    const key = [...pendingInvites].find(([, v]) => v.toCode === sess.userCode && (!fromCode || v.fromCode === fromCode));
    if (!key) return;
    const [pkey, inv] = key;
    pendingInvites.delete(pkey);

    if (!accept) {
      resumeIfInvitePaused(sess.userCode);
      emitToPlayer(inv.fromCode, 'inviteDeclined', { byName: sess.userName });
      return;
    }

    const room = rooms.get(inv.roomId);
    if (!room) {
      socket.emit('inviteError', '방이 이미 사라졌어요'); return;
    }
    if (room.members.size >= 4) {
      emitToPlayer(inv.fromCode, 'inviteError', '방이 꽉 찼습니다');
      emitToPlayer(sess.userCode, 'inviteError', '방이 꽉 찼습니다');
      return;
    }

    // 내 진행 중이던 싱글 게임 정리
    const g = singleGames.get(sess.userCode);
    if (g) {
      clearTimer(g);
      clearThankYouTimeout(g);
      g.status = 'ended';
      singleGames.delete(sess.userCode);
    }

    const expiresAt = Date.now() + 20000;
    inviteApprovedWaiting.set(sess.userCode, { roomId: room.id, expiresAt });

    emitToPlayer(inv.fromCode, 'inviteResponded', { accepted: true, byName: sess.userName });
    // 보낸 사람(sender)은 이미 방에 있으므로 그냥 UI만 정리, 받은 사람(receiver)만 joinRoomViaInvite로 실제 입장
    emitToPlayer(inv.fromCode, 'inviteAccepted', { role: 'sender', byName: sess.userName });
    emitToPlayer(sess.userCode, 'inviteAccepted', { role: 'receiver', roomId: room.id });
  });

  // 초대 수락 후 방 자동 입장 (페이지 이동으로 소켓이 재연결된 경우 포함, 코드 불필요)
  socket.on('joinRoomViaInvite', async () => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    const approved = inviteApprovedWaiting.get(sess.userCode);
    if (!approved || approved.expiresAt < Date.now()) {
      socket.emit('joinMultiError', '초대가 만료됐어요.'); return;
    }
    inviteApprovedWaiting.delete(sess.userCode);
    const room = rooms.get(approved.roomId);
    if (!room) { socket.emit('joinMultiError', '방이 이미 사라졌어요.'); return; }
    if (room.members.size >= 4) { socket.emit('joinMultiError', '방이 꽉 찼습니다 (최대 4명).'); return; }
    room.members.add(sess.userCode);
    sess.roomId = room.id;
    await broadcastRoomWaiting(room);
    broadcastRoomList();
    socket.emit('joinMultiOk', { roomId: room.id });
  });

  socket.on('charge', async ({ mode }) => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    const result = await db.chargeBalance(sess.userCode, mode);
    const user = await db.getUser(sess.userCode);
    socket.emit('chargeResult', { ...result, singlePoints: user.singlePoints, multiBalance: user.multiBalance });
  });

  socket.on('startSingle', async ({ continued } = {}) => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    const user = await db.getUser(sess.userCode);
    if (!user) return;

    // 멀티게임에 참가 중이면 AI로 교체하고 싱글 시작
    const myRoom = findRoomOfUser(user.userCode);
    if (myRoom?.game && myRoom.game.status === 'playing') {
      const inMulti = myRoom.game.players.find(p => p.userCode === user.userCode);
      if (inMulti) inMulti.isAI = true;
    }

    // 기존 싱글게임이 있으면 정리 후 교체
    const prev = singleGames.get(user.userCode);
    if (prev) {
      clearTimer(prev);
      clearThankYouTimeout(prev);
      prev.status = 'ended';
      singleGames.delete(user.userCode);
    }

    const aiPlayers = [
      { userCode: 'AI_1', userName: '돼지', isAI: true, avatar: 'pig' },
      { userCode: 'AI_2', userName: '강아지', isAI: true, avatar: 'dog' },
      { userCode: 'AI_3', userName: '호랑이', isAI: true, avatar: 'tiger' }
    ].sort(() => Math.random() - 0.5);
    const humanPlayer = { userCode: user.userCode, userName: user.userName, isAI: false, singlePoints: user.singlePoints, avatar: user.avatar || 'person' };

    // 지난 판 1등이 다음 판 선공, 나머지는 지난 판 좌석 순서 그대로 이어감(승자 기준으로 회전만)
    const lastWinnerCode = lastSingleWinners.get(user.userCode);
    const lastSeating = lastSingleSeating.get(user.userCode);
    let players;
    if (lastWinnerCode && lastWinnerCode !== user.userCode && lastSeating?.includes(lastWinnerCode)) {
      const byCode = new Map([humanPlayer, ...aiPlayers].map(p => [p.userCode, p]));
      const winnerIdx = lastSeating.indexOf(lastWinnerCode);
      const rotatedCodes = [...lastSeating.slice(winnerIdx), ...lastSeating.slice(0, winnerIdx)];
      players = rotatedCodes.map(code => byCode.get(code)).filter(Boolean);
      // 방어: 혹시 매핑 안 된 코드가 있으면(비정상 상황) 예전 방식으로 대체
      if (players.length !== 4) players = [humanPlayer, ...aiPlayers];
    } else {
      players = [humanPlayer, ...aiPlayers];
    }

    const game = createGame('single', players);
    game.continuedFromPrevious = !!continued;
    await snapshotRank1(game);
    singleGames.set(user.userCode, game);
    socket.emit('gameState', getPublicState(game, user.userCode));

    const cur = getCurrentPlayer(game);
    startInitialTurn(game, cur, 5000 + Math.random() * 3000);
  });

  // 멀티모드 진입: 잔액만 확인하고 바로 로비(방 목록)로
  socket.on('joinMulti', async () => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    const user = await db.getUser(sess.userCode);
    if (!user) return;
    if (user.multiBalance <= 0) { socket.emit('joinMultiError', '잔액이 없습니다.'); return; }
    socket.emit('joinMultiOk', { roomId: null });
  });

  socket.on('listRooms', () => {
    socket.emit('roomList', { rooms: [...rooms.values()].map(roomSummary) });
  });

  // 방 만들기: 제목 필수, 코드는 선택(없으면 잠금 없는 공개방), 초대 대상 최대 3명(선택)
  socket.on('createRoom', async ({ title, code, inviteTargets } = {}) => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    if (!isAvailableForRoom(sess.userCode)) { socket.emit('createRoomError', '이미 다른 방에 참여 중이에요'); return; }
    const trimmedTitle = (title || '').trim().slice(0, 20);
    if (!trimmedTitle) { socket.emit('createRoomError', '방 제목을 입력해주세요'); return; }
    const trimmedCode = (code || '').trim().slice(0, 10) || null;
    if (trimmedCode && [...rooms.values()].some(r => r.code === trimmedCode)) {
      socket.emit('createRoomError', '이미 사용 중인 방 코드예요'); return;
    }

    const room = {
      id: genRoomId(), title: trimmedTitle, code: trimmedCode,
      members: new Set([sess.userCode]),
      readyMembers: new Set(), // 방장 제외, 준비 완료한 멤버
      waiters: new Set(), // 게임 진행 중 들어와 관전하며 다음 판을 기다리는 인원
      waiterLeaveTimers: new Map(), // userCode → 연결 끊김 후 대기자를 실제로 내보내기까지의 유예 타이머
      game: null, lastGamePlayers: null, lastGameWinnerCode: null, readyPhase: null,
      createdBy: sess.userCode,
    };
    rooms.set(room.id, room);
    sess.roomId = room.id;
    broadcastRoomList();
    await broadcastRoomWaiting(room);
    socket.emit('createRoomOk', { roomId: room.id });

    const targets = (inviteTargets || []).slice(0, 3);
    for (const t of targets) {
      const r = await sendRoomInvite(sess, room, t);
      if (!r.ok) socket.emit('inviteError', r.msg);
    }
  });

  // 방 목록에서 방 선택: 코드 없는 방은 바로 입장, 코드 있는 방은 코드 검증
  socket.on('joinRoomByList', async ({ roomId, code } = {}) => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    if (!isAvailableForRoom(sess.userCode)) { socket.emit('joinMultiError', '이미 다른 방에 참여 중이에요'); return; }
    const room = rooms.get(roomId);
    if (!room) { socket.emit('joinMultiError', '존재하지 않는 방이에요'); return; }
    if (room.code && room.code !== (code || '').trim()) {
      socket.emit('joinRoomNeedsCode', { roomId: room.id, title: room.title }); return;
    }
    const user = await db.getUser(sess.userCode);
    if (!user || user.multiBalance <= 0) { socket.emit('joinMultiError', '잔액이 없습니다.'); return; }

    // 진행 중인 방: 정원(4명) 안에서만 관전(대기) 입장 허용
    if (room.game && room.game.status === 'playing') {
      const currentCount = room.game.players.filter(p => !p.isAI).length;
      if (currentCount + room.waiters.size >= 4) {
        socket.emit('joinMultiError', '정원이 찬 방입니다'); return;
      }
      room.waiters.add(sess.userCode);
      sess.roomId = room.id;
      socket.emit('gameState', getPublicState(room.game, sess.userCode));
      broadcastWaiterList(room);
      broadcastRoomList();
      socket.emit('spectateOk', { roomId: room.id });
      return;
    }

    if (room.members.size >= 4) { socket.emit('joinMultiError', '방이 꽉 찼습니다 (최대 4명).'); return; }
    room.members.add(sess.userCode);
    sess.roomId = room.id;
    await broadcastRoomWaiting(room);
    broadcastRoomList();
    socket.emit('joinMultiOk', { roomId: room.id });
  });

  // 방 대기실에서 다른 사람 초대 (누구나 가능)
  socket.on('inviteToRoom', async ({ targetUserCode } = {}) => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    const room = rooms.get(sess.roomId);
    if (!room) { socket.emit('inviteError', '방에 들어가있지 않아요'); return; }
    if (sess.userCode !== room.createdBy) { socket.emit('inviteError', '방장만 초대할 수 있어요'); return; }
    const r = await sendRoomInvite(sess, room, targetUserCode);
    if (r.ok) socket.emit('inviteSent', { toCode: targetUserCode, toName: r.toName, toAvatar: r.toAvatar });
    else socket.emit('inviteError', r.msg);
  });

  // 방 나가기 (게임 시작 전)
  // 게임 시작 전 "나가기": 나가고 나서 1명 이하만 남으면 방 자체를 없앰 (혼자 남아있어봐야 의미 없으니)
  socket.on('leaveRoom', () => {
    const sess = sessions.get(socket.id);
    if (!sess?.roomId) return;
    const room = rooms.get(sess.roomId);
    sess.roomId = null;
    if (!room) return;
    // 관전(대기) 중이던 사람이 나가기 — 게임/방 자체엔 영향 없음
    if (room.waiters.has(sess.userCode)) {
      room.waiters.delete(sess.userCode);
      broadcastWaiterList(room);
      broadcastRoomList();
      return;
    }
    room.members.delete(sess.userCode);
    room.readyMembers.delete(sess.userCode);
    // 방장이 나가거나, 나가고 나서 1명 이하만 남으면 방 자체를 없앰
    if (sess.userCode === room.createdBy || room.members.size <= 1) {
      closeRoom(room, `${sess.userName}님이 나가서 방이 사라졌어요`);
    } else {
      broadcastRoomWaiting(room);
      broadcastRoomList();
    }
  });

  // 방장이 다른 멤버를 방에서 내보냄 (게임 시작 전에만)
  socket.on('kickFromRoom', ({ targetUserCode } = {}) => {
    const sess = sessions.get(socket.id);
    if (!sess?.roomId) return;
    const room = rooms.get(sess.roomId);
    if (!room || sess.userCode !== room.createdBy) return;
    if (targetUserCode === room.createdBy) return;
    if (!room.members.has(targetUserCode)) return;

    room.members.delete(targetUserCode);
    room.readyMembers.delete(targetUserCode);
    const targetSid = getSocketId(targetUserCode);
    const targetSess = targetSid && sessions.get(targetSid);
    if (targetSess) targetSess.roomId = null;
    emitToPlayer(targetUserCode, 'kickedFromRoom', { roomTitle: room.title });

    broadcastRoomWaiting(room);
    broadcastRoomList();
  });

  // 게임 시작: 방 안에 있는 누구나 가능, 최소 2명, AI로 4명까지 채움
  // 방장이 아닌 멤버가 "준비" 누름
  socket.on('markRoomReady', () => {
    const sess = sessions.get(socket.id);
    if (!sess?.roomId) return;
    const room = rooms.get(sess.roomId);
    if (!room || sess.userCode === room.createdBy) return;
    room.readyMembers.add(sess.userCode);
    broadcastRoomWaiting(room);
  });

  socket.on('startRoomGame', async () => {
    const sess = sessions.get(socket.id);
    if (!sess?.roomId) return;
    const room = rooms.get(sess.roomId);
    if (!room) return;
    if (room.game && room.game.status === 'playing') return;
    if (sess.userCode !== room.createdBy) { emitToPlayer(sess.userCode, 'adminStartError', '방장만 시작할 수 있어요.'); return; }
    if (room.members.size < 2) { emitToPlayer(sess.userCode, 'adminStartError', '최소 2명 이상 필요합니다.'); return; }
    const othersReady = [...room.members].filter(uc => uc !== room.createdBy).every(uc => room.readyMembers.has(uc));
    if (!othersReady) { emitToPlayer(sess.userCode, 'adminStartError', '다른 사람들이 아직 준비되지 않았어요.'); return; }

    const humanPlayers = [];
    for (const uc of room.members) {
      const u = await db.getUser(uc);
      humanPlayers.push({ userCode: u.userCode, userName: u.userName, isAI: false, multiBalance: u.multiBalance, avatar: u.avatar || 'person' });
    }
    const aiPool = [
      { userCode: 'AI_1', userName: '돼지', isAI: true, avatar: 'pig' },
      { userCode: 'AI_2', userName: '호랑이', isAI: true, avatar: 'tiger' },
      { userCode: 'AI_3', userName: '강아지', isAI: true, avatar: 'dog' },
    ];
    const aiPlayers = aiPool.slice(0, 4 - humanPlayers.length);

    // 참가자들의 기존 싱글게임 정리
    for (const uc of room.members) {
      const prev = singleGames.get(uc);
      if (prev) {
        clearTimer(prev);
        clearThankYouTimeout(prev);
        prev.status = 'ended';
        singleGames.delete(uc);
      }
    }

    const allPlayers = [...humanPlayers, ...aiPlayers].sort(() => Math.random() - 0.5);
    room.game = createGame('multi', allPlayers);
    room.game.roomId = room.id;
    room.game.hostCode = room.createdBy;
    await snapshotRank1(room.game);
    room.members.clear();
    broadcastRoomList();

    for (const p of room.game.players) {
      if (p.isAI) continue;
      emitToPlayer(p.userCode, 'gameState', getPublicState(room.game, p.userCode));
    }

    const cur = getCurrentPlayer(room.game);
    startInitialTurn(room.game, cur, 2000 + Math.random() * 1000);
  });

  socket.on('adminStopGame', async () => {
    const sess = sessions.get(socket.id);
    if (!sess) return;

    const room = rooms.get(sess.roomId);
    if (room?.game && room.game.status === 'playing') {
      if (sess.userCode !== room.createdBy) return; // 방장만 게임 전체 중단 가능
      clearTimer(room.game);
      clearThankYouTimeout(room.game);
      room.game.status = 'ended';
      for (const p of room.game.players) {
        if (!p.isAI) emitToPlayer(p.userCode, 'gameStopped', {});
      }
      room.game = null;
      rooms.delete(room.id);
      broadcastRoomList();
      return;
    }

    // 방 게임이 아니면: 본인의 싱글 게임 중단
    const singleGame = singleGames.get(sess.userCode);
    if (singleGame) {
      clearTimer(singleGame);
      clearThankYouTimeout(singleGame);
      singleGame.status = 'ended';
      singleGames.delete(sess.userCode);
    }
    socket.emit('gameStopped', {});
  });

  socket.on('draw', ({ source }) => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    const game = getPlayerGame(sess.userCode);
    if (!game) return;
    const result = drawCard(game, sess.userCode, source);
    if (!result.ok) { socket.emit('actionError', result.msg); return; }
    broadcastLog(game, `${sess.userName} ${source === 'discard' ? '버린 더미' : '카드 더미'}에서 드로우`);
    broadcastGame(game);
    if (game.lastDeckDraw) {
      for (const p of game.players) {
        if (!p.isAI) emitToPlayer(p.userCode, 'deckEmpty', {});
      }
    }
  });

  socket.on('register', ({ cardIds }) => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    const game = getPlayerGame(sess.userCode);
    if (!game) return;
    const result = registerCards(game, sess.userCode, cardIds);
    if (!result.ok) { socket.emit('actionError', result.msg); return; }
    broadcastLog(game, `${sess.userName} 등록: [${result.combo.cards.map(cardName).join(', ')}]`);
    broadcastGame(game);
    if (result.win) { setTimeout(() => endGame(game, sess.userCode), 1000); return; }
  });

  socket.on('attach', ({ cardIds, comboId }) => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    const game = getPlayerGame(sess.userCode);
    if (!game) return;
    const attachingPlayer = game.players.find(p => p.userCode === sess.userCode);
    const attachingCards = cardIds.map(id => attachingPlayer?.hand.find(c => c.id === id)).filter(Boolean);
    const result = attachCards(game, sess.userCode, cardIds, comboId);
    if (!result.ok) { socket.emit('actionError', result.msg); return; }
    broadcastLog(game, `${sess.userName} 붙이기: [${attachingCards.map(cardName).join(', ')}]`);
    broadcastGame(game);
    if (result.win) { setTimeout(() => endGame(game, sess.userCode), 1000); return; }
  });

  socket.on('discard', ({ cardId }) => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    const game = getPlayerGame(sess.userCode);
    if (!game) return;
    const result = discardCard(game, sess.userCode, cardId);
    if (!result.ok) { socket.emit('actionError', result.msg); return; }
    broadcastLog(game, `${sess.userName} 카드 버림`);
    clearTimer(game);
    if (result.win) {
      broadcastGame(game); // 빈 패 먼저 보여주기
      setTimeout(() => endGame(game, sess.userCode), 1000);
      return;
    }
    if (game.lastDeckDraw) {
      game.lastDeckDraw = false;
      broadcastGame(game);
      setTimeout(() => endGame(game, null), 3000);
      return;
    }
    activateThankYouWindow(game, result.card);
  });

  // 일시정지 (싱글모드 전용) - 타이머/AI 진행을 멈추고 클라이언트가 일시정지 화면을 덮게 함
  socket.on('pauseGame', () => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    const game = getPlayerGame(sess.userCode);
    if (!game || game.mode !== 'single' || game.status !== 'playing') return;
    game.paused = true;
    game.timerRemainingMs = game.timerStart ? Math.max(0, 45000 - (Date.now() - game.timerStart)) : 45000;
    clearTimer(game);
    clearThankYouTimeout(game);
    broadcastGame(game);
  });

  socket.on('resumeGame', () => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    const game = getPlayerGame(sess.userCode);
    if (!game || game.mode !== 'single' || game.status !== 'playing') return;
    game.paused = false;
    const remaining = game.timerRemainingMs ?? 45000;
    game.timerRemainingMs = null;
    broadcastGame(game);
    const cur = getCurrentPlayer(game);
    startTimer(game, remaining);
    if (cur?.isAI) setTimeout(() => runAITurn(game, cur), 2000 + Math.random() * 1000);
  });

  socket.on('thankYou', () => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    const game = getPlayerGame(sess.userCode);
    if (!game) return;
    const result = tryThankYou(game, sess.userCode);
    if (!result.ok) {
      socket.emit('thankYouFailed', { msg: result.msg });
      return;
    }
    clearThankYouTimeout(game);
    const cty = confirmThankYou(game, sess.userCode);
    broadcastThankYouAnnounce(game, sess.userCode, sess.userName, cty.card);
    broadcastGame(game);
    startTimer(game);
  });

  socket.on('cancelThankYou', async () => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    const game = getPlayerGame(sess.userCode);
    if (!game) return;

    const result = cancelConfirmedThankYou(game, sess.userCode);
    if (!result.ok) return;

    const unit = game.mode === 'multi' ? 100 : 1;
    const others = game.players.filter(p => p.userCode !== sess.userCode);
    const penalty = unit * others.length;

    // 벌금 알림 먼저
    for (const p of game.players) {
      if (!p.isAI) emitToPlayer(p.userCode, 'thankYouCancelled', { cancellerCode: sess.userCode, penalty, gain: unit });
    }

    // 카드/차례 변경은 잠깐 후에 (알림이 먼저 보이도록)
    setTimeout(() => broadcastGame(game), 1200);

    // 정산 때 반영
    game.pendingChanges[sess.userCode] = (game.pendingChanges[sess.userCode] || 0) - penalty;
    for (const p of others) {
      game.pendingChanges[p.userCode] = (game.pendingChanges[p.userCode] || 0) + unit;
    }

    // 재땡큐 가능: AI들에게 다시 땡큐 기회 부여
    if (game.thankYou.active) {
      const discarderCode = game.thankYou.discarderCode;
      const cur = getCurrentPlayer(game);
      const windowCard = game.thankYou.card; // 이 창이 열릴 때의 카드 (늦게 발동돼도 다른 창의 카드로 오판하지 않도록 고정)
      for (const p of game.players) {
        if (!p.isAI || p.userCode === cur?.userCode || p.userCode === discarderCode) continue;
        const d = [1500, 2000, 3000, 4000][Math.floor(Math.random() * 4)];
        setTimeout(() => {
          if (!game.thankYou.active || game.thankYou.card !== windowCard || game.thankYou.lock || game.paused) return;
          const card = game.thankYou.card;
          const useful = isCardUseful(card, p.hand, game.combos, p.registered);
          if (!useful) return;
          console.log('[땡큐결정 진단(재땡큐)]', JSON.stringify({
            player: p.userName,
            userCode: p.userCode,
            card: cardName(card),
            registered: p.registered,
            handBefore: p.hand.map(cardName),
            existingCombos: game.combos.map(c => ({ id: c.id, type: c.type, cards: c.cards.map(cardName) })),
          }));
          const r = tryThankYou(game, p.userCode);
          if (r.ok) {
            const cty = confirmThankYou(game, p.userCode);
            broadcastThankYouAnnounce(game, p.userCode, p.userName, cty.card);
            setTimeout(() => {
              broadcastGame(game);
              startTimer(game);
              setTimeout(() => runAITurn(game, p), 2000 + Math.random() * 1000);
            }, 600);
          }
        }, d);
      }
    }

    // 원래 차례 플레이어(버린 사람 다음 순번) 타이머 시작
    const cur = getCurrentPlayer(game);
    startTimer(game);
    if (cur?.isAI) setTimeout(() => runAITurn(game, cur), 2000 + Math.random() * 1000);
  });

  socket.on('playAgain', async () => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    const room = rooms.get(sess.roomId);
    if (!room || !room.lastGamePlayers || room.game) return;

    // 오프라인 플레이어 확인
    const offlinePlayers = room.lastGamePlayers.filter(p => !p.isAI && !getSocketId(p.userCode));
    if (offlinePlayers.length > 0) {
      const names = offlinePlayers.map(p => p.userName).join(', ');
      for (const p of room.lastGamePlayers) {
        if (!p.isAI) emitToPlayer(p.userCode, 'playAgainError', `${names}님이 나갔습니다. 메뉴로 돌아갑니다.`);
      }
      return;
    }

    // 준비 안 된 사람 있으면 막기 (클라이언트 버튼도 막혀있지만 서버에서 재검증)
    if (room.readyPhase && room.readyPhase.requiredCodes.size > 0) {
      const notReady = [...room.readyPhase.requiredCodes].some(c => !room.readyPhase.readyCodes.has(c));
      if (notReady) return;
    }
    clearReadyPhase(room);

    // 승자 먼저, 나머지 이전 순서 유지
    let players = [...room.lastGamePlayers];
    if (room.lastGameWinnerCode) {
      const winnerIdx = players.findIndex(p => p.userCode === room.lastGameWinnerCode);
      if (winnerIdx > 0) players = [...players.slice(winnerIdx), ...players.slice(0, winnerIdx)];
    }

    // 대기(관전) 중이던 사람들을 AI 자리에 편입
    const waiterCodes = [...room.waiters].filter(uc => getSocketId(uc));
    if (waiterCodes.length > 0) {
      const waiterUsers = (await Promise.all(waiterCodes.map(uc => db.getUser(uc)))).filter(Boolean);
      let wi = 0;
      players = players.map(p => {
        if (p.isAI && wi < waiterUsers.length) {
          const u = waiterUsers[wi++];
          return { userCode: u.userCode, userName: u.userName, isAI: false, avatar: u.avatar || 'person', multiBalance: u.multiBalance };
        }
        return p;
      });
      room.waiters.clear();
    }

    // 멀티 잔액 최신 값 갱신
    players = await Promise.all(players.map(async p => {
      if (p.isAI) return p;
      const u = await db.getUser(p.userCode);
      return { ...p, multiBalance: u?.multiBalance ?? 0 };
    }));

    room.game = createGame('multi', players);
    room.game.roomId = room.id;
    room.game.hostCode = room.createdBy;
    await snapshotRank1(room.game);
    broadcastRoomList();

    for (const p of room.game.players) {
      if (!p.isAI) emitToPlayer(p.userCode, 'gameState', getPublicState(room.game, p.userCode));
    }

    const cur = getCurrentPlayer(room.game);
    startInitialTurn(room.game, cur, 2000 + Math.random() * 1000);
  });

  socket.on('readyForNextGame', () => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    markReady(sess.userCode);
  });

  socket.on('getRanking', async () => {
    const sess = sessions.get(socket.id);
    const canSee = sess?.isAdmin || sess?.showOnline !== false;
    const online = new Set(canSee ? visibleOnlineCodes() : []);
    const [multiRows, singleRows, hulaRows] = await Promise.all([
      db.getMultiRanking(), db.getSingleRanking(), db.getHulaRanking()
    ]);
    const hulaKingCode = hulaRows[0]?.userCode ?? null;
    const mark = rows => rows.map(r => ({
      ...r, online: online.has(r.userCode), isHulaKing: !!hulaKingCode && r.userCode === hulaKingCode
    }));
    socket.emit('ranking', {
      multi: mark(multiRows),
      single: mark(singleRows),
      hula: mark(hulaRows)
    });
  });

  socket.on('getMyStats', async ({ mode, scope, period } = {}) => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    mode = mode === 'multi' ? 'multi' : 'single';
    scope = scope === 'all' ? 'all' : 'me';
    period = ['week', 'month', 'all'].includes(period) ? period : 'month';

    const myUser = await db.getUser(sess.userCode);
    const myActualBalance = mode === 'multi' ? (myUser?.multiBalance ?? 0) : (myUser?.singlePoints ?? 0);

    const myRows = await db.getGameResultsForUser(sess.userCode, mode);
    const { maxGain, maxLoss } = statsUtils.computeMaxMinPointChange(myRows);
    const { maxWinStreak, maxLoseStreak } = statsUtils.computeStreaks(myRows);
    const myTrend = statsUtils.buildTrendSeries(myRows, period);
    const myCumulativeAnchored = statsUtils.anchorToActualBalance(myTrend.cumulative, myActualBalance);

    if (scope === 'me') {
      socket.emit('myStats', {
        mode, scope,
        summary: { maxGain, maxLoss, maxWinStreak, maxLoseStreak },
        periodTotals: {
          week: statsUtils.computePeriodTotals(myRows, 7),
          month: statsUtils.computePeriodTotals(myRows, 30),
        },
      });
      return;
    }

    // scope === 'all': 전체 유저 기록 보유자 + 상위 3명 비교
    const allRows = await db.getAllGameResults(mode);
    const allUsers = await db.getAllUsers();
    const userMap = new Map(allUsers.map(u => [u.userCode, u]));

    const byUser = new Map();
    for (const r of allRows) {
      if (!byUser.has(r.userCode)) byUser.set(r.userCode, []);
      byUser.get(r.userCode).push(r);
    }

    let globalMaxGain = null, globalMaxLoss = null;
    let globalMaxWinCount = 0, globalMaxWinHolders = [];
    let globalMaxLoseCount = 0, globalMaxLoseHolders = [];
    for (const [userCode, rows] of byUser) {
      const u = userMap.get(userCode);
      if (!u) continue;
      const mm = statsUtils.computeMaxMinPointChange(rows);
      const st = statsUtils.computeStreaks(rows);
      if (mm.maxGain && (!globalMaxGain || mm.maxGain.value > globalMaxGain.value)) {
        globalMaxGain = { ...mm.maxGain, userCode, userName: u.userName, avatar: u.avatar };
      }
      if (mm.maxLoss && (!globalMaxLoss || mm.maxLoss.value < globalMaxLoss.value)) {
        globalMaxLoss = { ...mm.maxLoss, userCode, userName: u.userName, avatar: u.avatar };
      }
      if (st.maxWinStreak.count > 0) {
        const holder = { ...st.maxWinStreak, userCode, userName: u.userName, avatar: u.avatar };
        if (st.maxWinStreak.count > globalMaxWinCount) { globalMaxWinCount = st.maxWinStreak.count; globalMaxWinHolders = [holder]; }
        else if (st.maxWinStreak.count === globalMaxWinCount) { globalMaxWinHolders.push(holder); }
      }
      if (st.maxLoseStreak.count > 0) {
        const holder = { ...st.maxLoseStreak, userCode, userName: u.userName, avatar: u.avatar };
        if (st.maxLoseStreak.count > globalMaxLoseCount) { globalMaxLoseCount = st.maxLoseStreak.count; globalMaxLoseHolders = [holder]; }
        else if (st.maxLoseStreak.count === globalMaxLoseCount) { globalMaxLoseHolders.push(holder); }
      }
    }

    // 상위 3명 고정 비교 — 내가 그 안에 있으면 필터에서 자연스럽게 빠져 "나"+2명=3줄, 없으면 "나"+3명=4줄
    const rankingRows = mode === 'multi' ? await db.getMultiRanking() : await db.getSingleRanking();
    const top3 = rankingRows.slice(0, 3);
    const dateKeys = myTrend.cumulative.map(p => p.date);

    function seriesFor(rows, actualBalance) {
      const dailyMap = statsUtils.buildDailySeries(rows);
      const cumPoints = statsUtils.alignSeriesToDates(dailyMap, dateKeys, 'cumulative');
      const cumAnchored = statsUtils.anchorToActualBalance(cumPoints, actualBalance);
      return {
        cumulative: cumAnchored.map(p => p.value),
        winRate: statsUtils.alignSeriesToDates(dailyMap, dateKeys, 'winRate').map(p => p.value),
      };
    }

    const others = top3
      .filter(r => r.userCode !== sess.userCode)
      .map(r => {
        const rank = rankingRows.findIndex(row => row.userCode === r.userCode) + 1;
        const actualBalance = mode === 'multi' ? r.multiBalance : r.singlePoints;
        return { userCode: r.userCode, userName: r.userName, avatar: r.avatar, rank, ...seriesFor(byUser.get(r.userCode) || [], actualBalance) };
      });

    const myRankIdx = rankingRows.findIndex(r => r.userCode === sess.userCode);
    const myRank = myRankIdx >= 0 ? myRankIdx + 1 : null;

    socket.emit('myStats', {
      mode, scope, period, myRank,
      records: {
        maxGain: globalMaxGain, maxLoss: globalMaxLoss,
        maxWinStreak: globalMaxWinHolders, maxLoseStreak: globalMaxLoseHolders,
      },
      trend: {
        dates: dateKeys,
        me: { cumulative: myCumulativeAnchored.map(p => p.value), winRate: myTrend.winRate.map(p => p.value) },
        others
      }
    });
  });

  socket.on('disconnect', async () => {
    const sess = sessions.get(socket.id);
    // 아래 로직들이 getSocketId()로 "지금 몇 명이나 온라인인지"를 정확히 계산할 수 있도록
    // 세션은 정리 로직을 실행하기 전에 먼저 지운다 (기존엔 맨 마지막에 지워서, 지금 끊기고
    // 있는 이 세션 자신이 "아직 온라인"으로 잘못 집계되는 문제가 있었음).
    sessions.delete(socket.id);
    if (sess) {
      const room = rooms.get(sess.roomId);
      if (room && !room.game && !room.lastGamePlayers) {
        // 게임을 아직 한 번도 시작 안 한, 순수 대기 중인 방에서 연결이 끊기면 바로 방에서 빠짐
        removeMemberFromRoom(room, sess.userCode);
      } else if (room && room.waiters.has(sess.userCode)) {
        // 관전(대기) 중이던 사람은 플레이어와 달리 일시정지 없이 자리를 반납하지만,
        // index.html → game.html 이동 자체가 순간적인 재연결을 유발하므로 짧은 유예를 둔다
        scheduleWaiterLeave(room, sess.userCode);
      } else if (room && !room.game && room.lastGamePlayers) {
        // "한 판 더" 준비 단계 중 연결이 끊긴 경우: 남은 인원이 1명 이하로 줄면 그 사람도 메인으로 돌려보냄
        checkAndCloseIfAlone(room);
      }
      presenceVisible.delete(sess.userCode);
      broadcastPresence();
      // 대기 중이던 초대 정리: 내가 보낸 초대는 취소, 나한테 온 초대는 상대에게 취소 알림
      for (const [key, inv] of [...pendingInvites]) {
        if (inv.fromCode === sess.userCode) {
          pendingInvites.delete(key);
          resumeIfInvitePaused(inv.toCode);
          emitToPlayer(inv.toCode, 'inviteCancelled', {});
        } else if (inv.toCode === sess.userCode) {
          pendingInvites.delete(key);
          emitToPlayer(inv.fromCode, 'inviteCancelled', {});
        }
      }
      // 싱글모드: 뒤로가기/탭닫기/네트워크끊김 등으로 연결이 끊기면 카드가 계속
      // 강제로 버려지지 않게 자동 일시정지. 재접속하면 paused 상태 그대로 복원되어
      // 일시정지 화면이 뜨고, 재개 버튼으로 이어할 수 있음.
      const singleGame = singleGames.get(sess.userCode);
      if (singleGame && singleGame.status === 'playing' && !singleGame.paused) {
        singleGame.paused = true;
        clearTimer(singleGame);
        clearThankYouTimeout(singleGame);
      }
      if (room?.game && room.game.status === 'playing') {
        const game = room.game;
        const disc = game.players.find(p => p.userCode === sess.userCode);
        if (disc) {
          disc.isAI = true;
          // 연결 끊긴 플레이어가 현재 차례면 타이머 취소 후 AI 턴 실행
          if (getCurrentPlayer(game)?.userCode === sess.userCode) {
            clearTimer(game);
            setTimeout(() => {
              if (game.status === 'playing' && getCurrentPlayer(game)?.userCode === sess.userCode) {
                runAITurn(game, disc);
              }
            }, 3000);
          }
          // 재접속 타이밍에 isAI=true로 AI 턴이 실행되지 않도록 짧은 딜레이 후 체크
          setTimeout(() => {
            const stillDisc = game.players.find(p => p.userCode === sess.userCode);
            if (!stillDisc || !stillDisc.isAI) return; // 이미 재접속됨
            const stillHuman = game.players.filter(p => !p.isAI);
            if (stillHuman.length <= 1) {
              for (const p of stillHuman) emitToPlayer(p.userCode, 'canStop', {});
            }
          }, 3000);
        }
      }
    }
  });

  function getPlayerGame(userCode) {
    for (const room of rooms.values()) {
      if (room.game?.players.some(p => p.userCode === userCode)) return room.game;
    }
    if (singleGames.has(userCode)) return singleGames.get(userCode);
    return null;
  }
});

// ── Start ──────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;

db.init().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`훌라 서버 실행 중: http://localhost:${PORT}`);
    const { networkInterfaces } = require('os');
    for (const n of Object.values(networkInterfaces())) {
      for (const net of n) {
        if (net.family === 'IPv4' && !net.internal) {
          console.log(`모바일 접속: http://${net.address}:${PORT}`);
        }
      }
    }
  });
}).catch(err => { console.error('DB 초기화 실패:', err); process.exit(1); });
