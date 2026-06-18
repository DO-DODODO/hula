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
const { decideDraw, decideActions, decideAttach, decideDiscard, isCardUseful } = require('./game/aiPlayer');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const sessions = new Map();
const waitingRoom = new Map();
let activeGame = null;
const singleGames = new Map();
let lastMultiGamePlayers = null;
let lastMultiGameWinnerCode = null;

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

  // 즉시 다음 턴으로 — 땡큐 창은 다음 플레이어가 덱에서 드로우할 때까지 유지
  nextTurn(game);
  broadcastGame(game);

  const cur = getCurrentPlayer(game);
  if (!cur) return;
  startTimer(game);

  // 현재 플레이어·버린 플레이어 제외한 다른 AI가 땡큐 고려 (5-7초 후)
  for (const p of game.players) {
    if (!p.isAI || p.userCode === cur.userCode || p.userCode === discarderCode) continue;
    const useful = isCardUseful(card, p.hand);
    const d = useful ? 5000 + Math.random() * 2000 : 6000 + Math.random() * 2000;
    const doIt = useful ? Math.random() < 0.7 : Math.random() < 0.1;
    if (doIt) {
      setTimeout(() => {
        if (!game.thankYou.active || game.thankYou.lock) return;
        const r = tryThankYou(game, p.userCode);
        if (r.ok) {
          confirmThankYou(game, p.userCode);
          broadcastThankYouAnnounce(game, p.userCode, p.userName);
          broadcastGame(game);
          startTimer(game);
          setTimeout(() => runAITurn(game, p), 2000 + Math.random() * 1000);
        }
      }, d);
    }
  }

  // 현재 플레이어가 AI면 덱에서 드로우 (땡큐 창 닫힘)
  if (cur.isAI) {
    setTimeout(() => runAITurn(game, cur), 1500 + Math.random() * 1000);
  }
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
    setTimeout(() => runAITurn(game, cur), 1500 + Math.random() * 1000);
  } else {
    startTimer(game);
  }
}

// ── AI Turn ────────────────────────────────────────────────────────────────

async function runAITurn(game, aiPlayer) {
  if (game.status !== 'playing') return;
  if (getCurrentPlayer(game)?.userCode !== aiPlayer.userCode) return;

  if (game.phase === 'draw') {
    // 땡큐 활성 중이면 현재 플레이어는 덱에서만 드로우 가능
    const discardTop = game.thankYou.active ? null :
      (game.discardPile.length > 0 ? game.discardPile[game.discardPile.length - 1] : null);
    const drawSrc = (!game.firstTurn && discardTop && decideDraw(aiPlayer.hand, discardTop) === 'discard') ? 'discard' : 'deck';

    if (game.deck.length === 0 && drawSrc === 'deck') { endGame(game, null); return; }

    broadcastLog(game, `${aiPlayer.userName} 생각 중...`);
    await sleep(500 + Math.random() * 500);

    drawCard(game, aiPlayer.userCode, drawSrc);
    broadcastLog(game, `${aiPlayer.userName} ${drawSrc === 'discard' ? '버린 더미' : '카드 더미'}에서 드로우`);
    broadcastGame(game);
    await sleep(500 + Math.random() * 500);
  }

  const actions = decideActions(aiPlayer.hand, game.combos, aiPlayer.registered);
  for (const action of actions) {
    if (action.type === 'register') {
      const r = registerCards(game, aiPlayer.userCode, action.cards.map(c => c.id));
      broadcastLog(game, `${aiPlayer.userName} 조합 등록!`);
      if (r.win) { endGame(game, aiPlayer.userCode); return; }
      broadcastGame(game);
      await sleep(500);
    }
  }

  if (aiPlayer.registered) {
    const attaches = decideAttach(aiPlayer.hand, game.combos, true);
    for (const a of attaches) {
      const r = attachCards(game, aiPlayer.userCode, [a.card.id], a.comboId);
      broadcastLog(game, `${aiPlayer.userName} 카드 붙이기`);
      if (r.win) { endGame(game, aiPlayer.userCode); return; }
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
  if (dr.win) { endGame(game, aiPlayer.userCode); return; }
  if (game.lastDeckDraw) { game.lastDeckDraw = false; endGame(game, null); return; }
  activateThankYouWindow(game, dr.card);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function broadcastLog(game, message) {
  for (const p of game.players) {
    if (!p.isAI) emitToPlayer(p.userCode, 'gameLog', message);
  }
}

function broadcastThankYouAnnounce(game, playerCode, playerName) {
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
  await db.saveGameResult(game.id, game.mode, results);

  for (const r of results) {
    if (!r.isAI) {
      const user = await db.getUser(r.userCode);
      r.currentBalance = game.mode === 'multi' ? user?.multiBalance : user?.singlePoints;
    }
  }

  const winnerName = results.find(r => r.rank === 1)?.userName;

  for (const p of game.players) {
    if (!p.isAI) {
      const user = await db.getUser(p.userCode);
      emitToPlayer(p.userCode, 'gameEnd', {
        results, winnerCode, winnerName,
        winMessage: winnerCode === p.userCode ? user?.winMessage : null
      });
    }
  }

  if (game.mode === 'single') {
    const sid = getSocketId(game.players.find(p => !p.isAI)?.userCode);
    if (sid) singleGames.delete(sid);
  } else {
    lastMultiGamePlayers = game.players.map(p => ({
      userCode: p.userCode, userName: p.userName, isAI: p.isAI
    }));
    lastMultiGameWinnerCode = winnerCode;
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
      winMessage: user.winMessage
    });
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
    if (existing) await db.updateUser(userCode, { userName, isAdmin: isAdmin ? 1 : 0 });
    else await db.createUser(userCode, userName, isAdmin ? 1 : 0);
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
    socket.emit('adminSetEntryCodeResult', { ok: true });
  });

  socket.on('setWinMessage', async ({ message }) => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    await db.updateUser(sess.userCode, { winMessage: message || '축하합니다!' });
    socket.emit('winMessageSaved');
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

    const players = [
      { userCode: user.userCode, userName: user.userName, isAI: false, singlePoints: user.singlePoints },
      { userCode: 'AI_1', userName: 'AI 1', isAI: true },
      { userCode: 'AI_2', userName: 'AI 2', isAI: true },
      { userCode: 'AI_3', userName: 'AI 3', isAI: true }
    ].sort(() => Math.random() - 0.5);

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
    const stored = await db.getSetting('entryCode');
    if (entryCode !== stored) { socket.emit('joinMultiError', '입장 코드가 틀렸습니다.'); return; }
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
      humanPlayers.push({ userCode: u.userCode, userName: u.userName, isAI: false, multiBalance: u.multiBalance });
    }
    const aiPlayers = [];
    for (let i = humanPlayers.length + 1; i <= 4; i++) {
      aiPlayers.push({ userCode: `AI_${i}`, userName: `AI ${i}`, isAI: true });
    }

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
    if (!activeGame) return;
    clearTimer(activeGame);
    clearThankYouTimeout(activeGame);
    activeGame.status = 'ended';
    for (const p of activeGame.players) {
      if (!p.isAI) emitToPlayer(p.userCode, 'gameStopped', {});
    }
    activeGame = null;
    waitingRoom.clear();
  });

  socket.on('draw', ({ source }) => {
    const sess = sessions.get(socket.id);
    if (!sess) return;
    const game = getPlayerGame(sess.userCode);
    if (!game) return;
    const result = drawCard(game, sess.userCode, source);
    if (!result.ok) { socket.emit('actionError', result.msg); return; }
    broadcastGame(game);
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
    if (result.win) { endGame(game, sess.userCode); return; }
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
    if (result.win) { endGame(game, sess.userCode); return; }
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
      setTimeout(() => endGame(game, sess.userCode), 700);
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
    if (!result.ok) { socket.emit('actionError', result.msg); return; }
    clearThankYouTimeout(game);
    confirmThankYou(game, sess.userCode);
    broadcastThankYouAnnounce(game, sess.userCode, sess.userName);
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

    broadcastGame(game);

    const unit = game.mode === 'multi' ? 100 : 1;
    const others = game.players.filter(p => p.userCode !== sess.userCode);
    const penalty = unit * others.length;

    const me = await db.getUser(sess.userCode);
    if (me) {
      const key = game.mode === 'multi' ? 'multiBalance' : 'singlePoints';
      await db.updateUser(sess.userCode, { [key]: Math.max(0, me[key] - penalty) });
    }
    for (const p of others) {
      if (!p.isAI) {
        const u = await db.getUser(p.userCode);
        if (u) {
          const key = game.mode === 'multi' ? 'multiBalance' : 'singlePoints';
          await db.updateUser(p.userCode, { [key]: u[key] + unit });
        }
      }
    }

    for (const p of game.players) {
      if (!p.isAI) emitToPlayer(p.userCode, 'thankYouCancelled', { cancellerCode: sess.userCode, penalty, gain: unit });
    }

    // advanceTurn 대신 복귀된 원래 차례 플레이어의 타이머 시작
    const cur = getCurrentPlayer(game);
    startTimer(game);
    if (cur?.isAI) setTimeout(() => runAITurn(game, cur), 1500 + Math.random() * 1000);
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
