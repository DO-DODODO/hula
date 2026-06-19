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
const { canAttach } = require('./game/cardUtils');
const { getUserCount } = require('./db/database');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const sessions = new Map();
const waitingRoom = new Map();
let activeGame = null;
const singleGames = new Map();
const lastSingleWinners = new Map(); // socket.id → 마지막 싱글 승자 userCode
let lastMultiGamePlayers = null;
let lastMultiGameWinnerCode = null;
const entryAttempts = new Map(); // socket.id → 시도 횟수
const entryBlocked = new Set();  // socket.id → 차단

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
}

// ── Timer ──────────────────────────────────────────────────────────────────

function startTimer(game, durationMs = 60000) {
  clearTimer(game);
  game.timerStart = Date.now();
  game.timer = setTimeout(() => handleTimeout(game), durationMs);
}

function clearTimer(game) {
  if (game.timer) { clearTimeout(game.timer); game.timer = null; }
}

function handleTimeout(game) {
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
      if (game.thankYou.active) {
        const discarderCode = game.thankYou.discarderCode;
        const card = game.thankYou.card;
        const cur = getCurrentPlayer(game);
        for (const p of game.players) {
          if (!p.isAI || p.userCode === cur?.userCode || p.userCode === discarderCode) continue;
          const useful = isCardUseful(card, p.hand, game.combos, p.registered);
          const d = useful ? 3000 + Math.random() * 4000 : 5000 + Math.random() * 3000;
          if (useful ? Math.random() < 0.6 : Math.random() < 0.1) {
            setTimeout(() => {
              if (!game.thankYou.active || game.thankYou.lock) return;
              const r = tryThankYou(game, p.userCode);
              if (r.ok) {
                const cty = confirmThankYou(game, p.userCode);
                broadcastThankYouAnnounce(game, p.userCode, p.userName, cty.card);
                broadcastGame(game);
                startTimer(game);
                setTimeout(() => runAITurn(game, p), 2000 + Math.random() * 1000);
              }
            }, d);
          }
        }
        if (cur?.isAI) setTimeout(() => runAITurn(game, cur), 2000 + Math.random() * 1000);
      }
    }, 1200);

    // 정산 때 반영 (pendingChanges에 기록)
    game.pendingChanges[takerCode] = (game.pendingChanges[takerCode] || 0) - penalty;
    for (const p of others) {
      if (!p.isAI) game.pendingChanges[p.userCode] = (game.pendingChanges[p.userCode] || 0) + unit;
    }
    return;
  }

  const result = autoTimeout(game);
  if (result.deckEmpty) { endGame(game, null); return; }

  broadcastGame(game);
  if (game.lastDeckDraw) { game.lastDeckDraw = false; endGame(game, null); return; }
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

    const cur = getCurrentPlayer(game);
    if (!cur) return;
    startTimer(game);

    // 현재 플레이어·버린 플레이어 제외한 다른 AI가 땡큐 고려 (3~7초 랜덤)
    for (const p of game.players) {
      if (!p.isAI || p.userCode === cur.userCode || p.userCode === discarderCode) continue;
      const useful = isCardUseful(card, p.hand, game.combos, p.registered);
      const d = useful ? 3000 + Math.random() * 4000 : 5000 + Math.random() * 3000;
      const doIt = useful ? Math.random() < 0.75 : Math.random() < 0.15;
      if (doIt) {
        setTimeout(() => {
          if (!game.thankYou.active || game.thankYou.lock) return;
          const r = tryThankYou(game, p.userCode);
          if (r.ok) {
            const cty = confirmThankYou(game, p.userCode);
            broadcastThankYouAnnounce(game, p.userCode, p.userName, cty.card);
            broadcastGame(game);
            startTimer(game);
            setTimeout(() => runAITurn(game, p), 2000 + Math.random() * 1000);
          }
        }, d);
      }
    }

    // 현재 플레이어가 AI면 드로우 (2~5초 랜덤 → 땡큐와 타이밍 겹침)
    if (cur.isAI) {
      setTimeout(() => runAITurn(game, cur), 2000 + Math.random() * 3000);
    }
  }, 300);
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
  if (cur.isAI) {
    startTimer(game);
    setTimeout(() => runAITurn(game, cur), 2000 + Math.random() * 1000);
  } else {
    startTimer(game);
  }
}

// ── AI Turn ────────────────────────────────────────────────────────────────

async function runAITurn(game, aiPlayer) {
  if (game.status !== 'playing') return;
  if (getCurrentPlayer(game)?.userCode !== aiPlayer.userCode) return;

  if (game.phase === 'draw') {
    // 땡큐 활성 중이거나 버린더미 hidden이면 덱에서만 드로우 가능
    const discardTop = (game.thankYou.active || game.discardPileHidden) ? null :
      (game.discardPile.length > 0 ? game.discardPile[game.discardPile.length - 1] : null);
    const drawSrc = (!game.firstTurn && discardTop && decideDraw(aiPlayer.hand, discardTop) === 'discard') ? 'discard' : 'deck';

    if (game.deck.length === 0 && drawSrc === 'deck') { endGame(game, null); return; }

    broadcastLog(game, `${aiPlayer.userName} 생각 중...`);
    await sleep(500 + Math.random() * 500);

    // 생각 중 사이에 다른 사람이 땡큐해서 턴이 바뀌었으면 종료
    if (getCurrentPlayer(game)?.userCode !== aiPlayer.userCode) return;

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
  }

  // 땡큐 테이커: 가져온 카드를 반드시 먼저 사용
  if (game.thankYouTaker === aiPlayer.userCode && game.thankYouTakerCard) {
    const takerCard = game.thankYouTakerCard;
    if (aiPlayer.hand.some(c => c.id === takerCard.id)) {
      // 1. 땡큐 카드 포함한 조합 등록 시도
      const combos = findCombos(aiPlayer.hand);
      const comboWithCard = combos.find(cb => cb.cards.some(c => c.id === takerCard.id));
      if (comboWithCard) {
        const r = registerCards(game, aiPlayer.userCode, comboWithCard.cards.map(c => c.id));
        broadcastLog(game, `${aiPlayer.userName} 조합 등록!`);
        if (r.win) { broadcastGame(game); await sleep(800); endGame(game, aiPlayer.userCode); return; }
        broadcastGame(game);
        await sleep(500);
      } else {
        // 2. 기존 조합에 붙이기 시도
        let attached = false;
        for (const combo of game.combos) {
          if (canAttach(combo, takerCard)) {
            const r = attachCards(game, aiPlayer.userCode, [takerCard.id], combo.id);
            if (r.ok) {
              broadcastLog(game, `${aiPlayer.userName} 카드 붙이기`);
              if (r.win) { broadcastGame(game); await sleep(800); endGame(game, aiPlayer.userCode); return; }
              broadcastGame(game);
              await sleep(400);
              attached = true;
              break;
            }
          }
        }
        if (!attached) {
          // 3. 못 쓰면 자동 취소 + 벌금
          const cres = cancelConfirmedThankYou(game, aiPlayer.userCode);
          if (cres.ok) {
            const unit = game.mode === 'multi' ? 100 : 1;
            const others = game.players.filter(p => p.userCode !== aiPlayer.userCode);
            const penalty = unit * others.length;
            game.pendingChanges[aiPlayer.userCode] = (game.pendingChanges[aiPlayer.userCode] || 0) - penalty;
            for (const p of others) {
              if (!p.isAI) game.pendingChanges[p.userCode] = (game.pendingChanges[p.userCode] || 0) + unit;
            }
            // 클라이언트에 취소 알림 (말풍선용)
            for (const p of game.players) {
              if (!p.isAI) emitToPlayer(p.userCode, 'thankYouCancelled', { cancellerCode: aiPlayer.userCode, penalty, gain: unit });
            }
            broadcastLog(game, `${aiPlayer.userName} 땡큐 취소 (벌금 부과)`);
            setTimeout(() => {
              broadcastGame(game);
              if (game.thankYou.active) {
                const cur = getCurrentPlayer(game);
                if (cur?.isAI) setTimeout(() => runAITurn(game, cur), 2000 + Math.random() * 1000);
              }
            }, 1200);
          }
          return;
        }
      }
    }
  }

  const actions = decideActions(aiPlayer.hand, game.combos, aiPlayer.registered);
  for (const action of actions) {
    if (action.type === 'register') {
      const r = registerCards(game, aiPlayer.userCode, action.cards.map(c => c.id));
      broadcastLog(game, `${aiPlayer.userName} 조합 등록!`);
      if (r.win) { broadcastGame(game); await sleep(800); endGame(game, aiPlayer.userCode); return; }
      broadcastGame(game);
      await sleep(500);
    }
  }

  if (aiPlayer.registered) {
    const attaches = decideAttach(aiPlayer.hand, game.combos, true);
    for (const a of attaches) {
      const r = attachCards(game, aiPlayer.userCode, [a.card.id], a.comboId);
      broadcastLog(game, `${aiPlayer.userName} 카드 붙이기`);
      if (r.win) { broadcastGame(game); await sleep(800); endGame(game, aiPlayer.userCode); return; }
      broadcastGame(game);
      await sleep(400);
    }
  }

  await sleep(400 + Math.random() * 300);

  const cardToDiscard = decideDiscard(aiPlayer.hand);
  const dr = discardCard(game, aiPlayer.userCode, cardToDiscard.id);
  if (!dr.ok) return;

  broadcastLog(game, `${aiPlayer.userName} 카드 버림`);
  clearTimer(game);
  if (dr.win) { broadcastGame(game); await sleep(800); endGame(game, aiPlayer.userCode); return; }
  if (game.lastDeckDraw) { game.lastDeckDraw = false; endGame(game, null); return; }
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

  const results = calculateResults(game, winnerCode);
  // 실제 1등(덱 소진 시에도 포함)을 다음 판 선공 결정에 활용
  const actualWinnerCode = results.find(r => r.rank === 1)?.userCode || null;

  await db.saveGameResult(game.id, game.mode, results);

  for (const r of results) {
    if (!r.isAI) {
      const user = await db.getUser(r.userCode);
      r.currentBalance = game.mode === 'multi' ? user?.multiBalance : user?.singlePoints;
      r.totalWins = game.mode === 'multi' ? (user?.multiWins ?? 0) : (user?.singleWins ?? 0);
      r.totalGames = game.mode === 'multi' ? (user?.multiGames ?? 0) : (user?.singleGames ?? 0);
    }
  }

  const winnerName = results.find(r => r.rank === 1)?.userName;

  for (const p of game.players) {
    if (!p.isAI) {
      const user = await db.getUser(p.userCode);
      emitToPlayer(p.userCode, 'gameEnd', {
        results, winnerCode: actualWinnerCode, winnerName,
        winMessage: actualWinnerCode === p.userCode ? user?.winMessage : null
      });
    }
  }

  if (game.mode === 'single') {
    const humanPlayer = game.players.find(p => !p.isAI);
    const sid = getSocketId(humanPlayer?.userCode);
    if (sid) {
      lastSingleWinners.set(sid, actualWinnerCode);
      singleGames.delete(sid);
    }
  } else {
    lastMultiGamePlayers = game.players.map(p => ({
      userCode: p.userCode, userName: p.userName, isAI: p.isAI, avatar: p.avatar
    }));
    lastMultiGameWinnerCode = actualWinnerCode;
    activeGame = null;
  }
}

// ── Socket.io ──────────────────────────────────────────────────────────────

io.on('connection', (socket) => {

  socket.on('login', async ({ userCode }) => {
    const user = await db.getUser(userCode);
    if (!user) { socket.emit('loginError', '등록되지 않은 코드입니다.'); return; }
    sessions.set(socket.id, { userCode: user.userCode, userName: user.userName });
    socket.emit('loginSuccess', {
      userCode: user.userCode, userName: user.userName,
      isAdmin: user.isAdmin === 1,
      singlePoints: user.singlePoints, multiBalance: user.multiBalance,
      winMessage: user.winMessage, avatar: user.avatar || 'person'
    });
    // game.html로 이동 후 새 소켓으로 재접속한 경우 → 플레이어 복구 후 게임 상태 재전송
    if (activeGame && activeGame.status === 'playing') {
      const player = activeGame.players.find(p => p.userCode === user.userCode);
      if (player) {
        player.isAI = false; // 잠깐 끊긴 동안 AI로 전환된 것 복구
        socket.emit('gameState', getPublicState(activeGame, user.userCode));
      }
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

  socket.on('adminSetEntryCode', async ({ code }) => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    const me = await db.getUser(sess.userCode);
    if (!me?.isAdmin) return;
    await db.setSetting('entryCode', code);
    // 코드 변경 시 입장 차단 및 시도 횟수 초기화
    entryAttempts.clear();
    entryBlocked.clear();
    socket.emit('adminSetEntryCodeResult', { ok: true });
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

  socket.on('charge', async ({ mode }) => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    const result = await db.chargeBalance(sess.userCode, mode);
    const user = await db.getUser(sess.userCode);
    socket.emit('chargeResult', { ...result, singlePoints: user.singlePoints, multiBalance: user.multiBalance });
  });

  socket.on('startSingle', async () => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    const user = await db.getUser(sess.userCode);
    if (!user) return;

    // 기존 게임이 있으면 타이머·상태 정리 후 교체
    const prev = singleGames.get(socket.id);
    if (prev) {
      clearTimer(prev);
      clearThankYouTimeout(prev);
      prev.status = 'ended';
      singleGames.delete(socket.id);
    }

    const aiPlayers = [
      { userCode: 'AI_1', userName: '돼지', isAI: true, avatar: 'pig' },
      { userCode: 'AI_2', userName: '강아지', isAI: true, avatar: 'dog' },
      { userCode: 'AI_3', userName: '호랑이', isAI: true, avatar: 'tiger' }
    ].sort(() => Math.random() - 0.5);
    const humanPlayer = { userCode: user.userCode, userName: user.userName, isAI: false, singlePoints: user.singlePoints, avatar: user.avatar || 'person' };

    // 지난 판 1등이 다음 판 선공
    const lastWinnerCode = lastSingleWinners.get(socket.id);
    let players;
    if (lastWinnerCode && lastWinnerCode !== user.userCode) {
      const winnerAI = aiPlayers.find(p => p.userCode === lastWinnerCode);
      if (winnerAI) {
        const otherAIs = aiPlayers.filter(p => p.userCode !== lastWinnerCode);
        players = [winnerAI, humanPlayer, ...otherAIs];
      } else {
        players = [humanPlayer, ...aiPlayers];
      }
    } else {
      players = [humanPlayer, ...aiPlayers];
    }

    const game = createGame('single', players);
    singleGames.set(socket.id, game);
    socket.emit('gameState', getPublicState(game, user.userCode));

    const cur = getCurrentPlayer(game);
    startTimer(game);
    if (cur.isAI) setTimeout(() => runAITurn(game, cur), 5000 + Math.random() * 3000);
  });

  socket.on('joinMulti', async ({ entryCode }) => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    if (entryBlocked.has(socket.id)) {
      socket.emit('joinMultiError', '입장 코드 5회 초과. 코드 변경 후 다시 시도하세요.');
      return;
    }
    const stored = await db.getSetting('entryCode');
    if (entryCode !== stored) {
      const cnt = (entryAttempts.get(socket.id) || 0) + 1;
      entryAttempts.set(socket.id, cnt);
      if (cnt >= 5) {
        entryBlocked.add(socket.id);
        socket.emit('joinMultiError', `입장 코드가 틀렸습니다. (${cnt}/5회 - 입장 차단)`);
      } else {
        socket.emit('joinMultiError', `입장 코드가 틀렸습니다. (${cnt}/5회)`);
      }
      return;
    }
    entryAttempts.delete(socket.id);
    const user = await db.getUser(sess.userCode);
    if (!user) return;
    if (user.multiBalance < 1000) { socket.emit('joinMultiError', '잔액이 1,000원 미만입니다.'); return; }
    waitingRoom.set(sess.userCode, socket.id);
    socket.join('waiting');
    await broadcastWaiting();
    socket.emit('joinMultiOk');
  });

  async function broadcastWaiting() {
    const players = [];
    for (const [uc] of waitingRoom) {
      const u = await db.getUser(uc);
      if (u) players.push({ userCode: u.userCode, userName: u.userName, isAdmin: u.isAdmin === 1 });
    }
    io.to('waiting').emit('waitingRoom', { players });
  }

  socket.on('adminStartGame', async () => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    const me = await db.getUser(sess.userCode);
    if (!me?.isAdmin) return;
    if (waitingRoom.size < 2) { socket.emit('adminStartError', '최소 2명 이상 필요합니다.'); return; }

    const humanPlayers = [];
    for (const [uc] of waitingRoom) {
      const u = await db.getUser(uc);
      humanPlayers.push({ userCode: u.userCode, userName: u.userName, isAI: false, multiBalance: u.multiBalance, avatar: u.avatar || 'person' });
    }
    const aiPool = [
      { userCode: 'AI_1', userName: '돼지', isAI: true, avatar: 'pig' },
      { userCode: 'AI_2', userName: '호랑이', isAI: true, avatar: 'tiger' },
      { userCode: 'AI_3', userName: '강아지', isAI: true, avatar: 'dog' },
    ];
    const aiPlayers = aiPool.slice(0, 4 - humanPlayers.length);

    const allPlayers = [...humanPlayers, ...aiPlayers].sort(() => Math.random() - 0.5);
    activeGame = createGame('multi', allPlayers);
    waitingRoom.clear();

    for (const p of activeGame.players) {
      if (!p.isAI) emitToPlayer(p.userCode, 'gameState', getPublicState(activeGame, p.userCode));
    }

    const cur = getCurrentPlayer(activeGame);
    startTimer(activeGame);
    if (cur.isAI) setTimeout(() => runAITurn(activeGame, cur), 2000 + Math.random() * 1000);
  });

  socket.on('adminStopGame', async () => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    const me = await db.getUser(sess.userCode);
    if (!me?.isAdmin) return;

    if (activeGame) {
      clearTimer(activeGame);
      clearThankYouTimeout(activeGame);
      activeGame.status = 'ended';
      for (const p of activeGame.players) {
        if (!p.isAI) emitToPlayer(p.userCode, 'gameStopped', {});
      }
      activeGame = null;
      waitingRoom.clear();
    } else {
      // 싱글모드: 어드민 본인의 싱글 게임 중단
      const singleGame = singleGames.get(socket.id);
      if (singleGame) {
        clearTimer(singleGame);
        clearThankYouTimeout(singleGame);
        singleGame.status = 'ended';
        singleGames.delete(socket.id);
      }
      socket.emit('gameStopped', {});
    }
  });

  socket.on('draw', ({ source }) => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    const game = getPlayerGame(sess.userCode);
    if (!game) return;
    const result = drawCard(game, sess.userCode, source);
    if (!result.ok) { socket.emit('actionError', result.msg); return; }
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
    broadcastLog(game, `${sess.userName} 조합 등록!`);
    broadcastGame(game);
    if (result.win) { setTimeout(() => endGame(game, sess.userCode), 1000); return; }
  });

  socket.on('attach', ({ cardIds, comboId }) => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    const game = getPlayerGame(sess.userCode);
    if (!game) return;
    const result = attachCards(game, sess.userCode, cardIds, comboId);
    if (!result.ok) { socket.emit('actionError', result.msg); return; }
    broadcastLog(game, `${sess.userName} 카드 붙이기`);
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
      endGame(game, null);
      return;
    }
    activateThankYouWindow(game, result.card);
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

    // 확정 후 취소 (내 턴에 취소 버튼 누름)
    const result = cancelConfirmedThankYou(game, sess.userCode);
    if (!result.ok) return;

    const unit = game.mode === 'multi' ? 100 : 1;
    const others = game.players.filter(p => p.userCode !== sess.userCode);
    const penalty = unit * others.length;

    // 1. 벌금 알림 먼저
    for (const p of game.players) {
      if (!p.isAI) emitToPlayer(p.userCode, 'thankYouCancelled', { cancellerCode: sess.userCode, penalty, gain: unit });
    }

    // 2. 카드/차례 변경은 잠깐 후에 (알림이 먼저 보이도록)
    setTimeout(() => broadcastGame(game), 1200);

    // 3. 정산 때 반영 (pendingChanges에 기록)
    game.pendingChanges[sess.userCode] = (game.pendingChanges[sess.userCode] || 0) - penalty;
    for (const p of others) {
      if (!p.isAI) game.pendingChanges[p.userCode] = (game.pendingChanges[p.userCode] || 0) + unit;
    }

    // 재땡큐 가능: AI들에게 다시 땡큐 기회 부여
    if (game.thankYou.active) {
      const discarderCode = game.thankYou.discarderCode;
      const card = game.thankYou.card;
      const cur = getCurrentPlayer(game);
      for (const p of game.players) {
        if (!p.isAI || p.userCode === cur?.userCode || p.userCode === discarderCode) continue;
        const useful = isCardUseful(card, p.hand);
        const d = useful ? 3000 + Math.random() * 4000 : 5000 + Math.random() * 3000;
        const doIt = useful ? Math.random() < 0.6 : Math.random() < 0.1;
        if (doIt) {
          setTimeout(() => {
            if (!game.thankYou.active || game.thankYou.lock) return;
            const r = tryThankYou(game, p.userCode);
            if (r.ok) {
              const cty = confirmThankYou(game, p.userCode);
              broadcastThankYouAnnounce(game, p.userCode, p.userName, cty.card);
              broadcastGame(game);
              startTimer(game);
              setTimeout(() => runAITurn(game, p), 2000 + Math.random() * 1000);
            }
          }, d);
        }
      }
    }

    // 원래 차례 플레이어 타이머 시작
    const cur = getCurrentPlayer(game);
    startTimer(game);
    if (cur?.isAI) setTimeout(() => runAITurn(game, cur), 2000 + Math.random() * 1000);
  });

  socket.on('playAgain', async () => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    const me = await db.getUser(sess.userCode);
    if (!me?.isAdmin) return;
    if (!lastMultiGamePlayers || activeGame) return;

    // 승자 먼저, 나머지 이전 순서 유지
    let players = [...lastMultiGamePlayers];
    if (lastMultiGameWinnerCode) {
      const winnerIdx = players.findIndex(p => p.userCode === lastMultiGameWinnerCode);
      if (winnerIdx > 0) players = [...players.slice(winnerIdx), ...players.slice(0, winnerIdx)];
    }

    // 멀티 잔액 최신 값 갱신
    players = await Promise.all(players.map(async p => {
      if (p.isAI) return p;
      const u = await db.getUser(p.userCode);
      return { ...p, multiBalance: u?.multiBalance ?? 0 };
    }));

    activeGame = createGame('multi', players);
    waitingRoom.clear();

    for (const p of activeGame.players) {
      if (!p.isAI) emitToPlayer(p.userCode, 'gameState', getPublicState(activeGame, p.userCode));
    }

    const cur = getCurrentPlayer(activeGame);
    startTimer(activeGame);
    if (cur.isAI) setTimeout(() => runAITurn(activeGame, cur), 2000 + Math.random() * 1000);
  });

  socket.on('getRanking', async () => {
    socket.emit('ranking', {
      multi: await db.getMultiRanking(),
      single: await db.getSingleRanking()
    });
  });

  socket.on('leaveWaiting', () => {
    const sess = sessions.get(socket.id);
    if (sess) {
      waitingRoom.delete(sess.userCode);
      socket.leave('waiting');
    }
  });

  socket.on('disconnect', async () => {
    const sess = sessions.get(socket.id);
    if (sess) {
      waitingRoom.delete(sess.userCode);
      if (activeGame) {
        const disc = activeGame.players.find(p => p.userCode === sess.userCode);
        if (disc) {
          disc.isAI = true;
          const stillHuman = activeGame.players.filter(p => !p.isAI);
          if (stillHuman.length <= 1) {
            for (const p of stillHuman) emitToPlayer(p.userCode, 'canStop', {});
          }
        }
      }
    }
    sessions.delete(socket.id);
    singleGames.delete(socket.id);
  });

  function getPlayerGame(userCode) {
    const sid = getSocketId(userCode);
    if (!sid) return null;
    if (singleGames.has(sid)) return singleGames.get(sid);
    if (activeGame?.players.some(p => p.userCode === userCode)) return activeGame;
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
