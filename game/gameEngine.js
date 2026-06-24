const { createDeck, shuffle, handScore, isValidCombo, getComboType, canAttach, getComboTypeAfterAttach } = require('./cardUtils');
const { decideDraw, decideThankYou, decideActions, decideAttach, decideDiscard } = require('./aiPlayer');

let gameIdCounter = 1;
let comboIdCounter = 1;

function createGame(mode, players) {
  const deck = shuffle(createDeck());
  const gamePlayers = players.map((p, idx) => ({
    ...p,
    hand: deck.splice(0, 7),
    registered: false,
    seatIndex: idx
  }));

  return {
    id: `game_${gameIdCounter++}`,
    mode,
    status: 'playing',
    players: gamePlayers,
    deck,
    discardPile: [],
    combos: [],
    turnIndex: 0,
    phase: 'draw',
    drawnCard: null,
    thankYou: { active: false, lock: null, card: null, discarderCode: null },
    thankYouTaker: null,
    thankYouTakerCard: null,
    thankYouDisplacedTurnIndex: null,
    thankYouDisplacedDiscarder: null,
    lastDeckDraw: false,
    discardPileHidden: false,
    pendingChanges: {},
    timer: null,
    timerStart: null,
    firstTurn: true
  };
}

function getCurrentPlayer(game) {
  return game.players[game.turnIndex];
}

function getPublicState(game, viewerCode = null) {
  return {
    id: game.id,
    mode: game.mode,
    status: game.status,
    players: game.players.map(p => ({
      userCode: p.userCode,
      userName: p.userName,
      isAI: p.isAI,
      seatIndex: p.seatIndex,
      handCount: p.hand.length,
      hand: p.userCode === viewerCode ? p.hand : null,
      registered: p.registered,
      avatar: p.avatar,
      singlePoints: p.userCode === viewerCode ? p.singlePoints : undefined,
      multiBalance: p.userCode === viewerCode ? p.multiBalance : undefined
    })),
    deck: { count: game.deck.length },
    discardPile: (() => {
      // 땡큐 창 활성 중: 카드가 임시로 빠져있으므로 thankYou.card를 맨 위로 표시
      if (game.thankYou.active && game.thankYou.card) {
        return { top: game.thankYou.card, count: game.discardPile.length + 1 };
      }
      if (game.discardPile.length > 0) {
        return game.discardPileHidden
          ? { top: game.discardPile[game.discardPile.length - 1] ?? null, count: game.discardPile.length, hidden: true }
          : { top: game.discardPile[game.discardPile.length - 1], count: game.discardPile.length };
      }
      return null;
    })(),
    combos: game.combos,
    turnIndex: game.turnIndex,
    currentPlayerCode: getCurrentPlayer(game)?.userCode,
    phase: game.phase,
    thankYou: game.thankYou,
    thankYouTaker: game.thankYouTaker,
    firstTurn: game.firstTurn
  };
}

// Draw card from source
function drawCard(game, playerCode, source) {
  const player = game.players.find(p => p.userCode === playerCode);
  if (!player) return { ok: false, msg: '플레이어 없음' };
  if (game.phase !== 'draw') return { ok: false, msg: '드로우 단계가 아닙니다' };
  if (getCurrentPlayer(game).userCode !== playerCode) return { ok: false, msg: '당신 차례가 아닙니다' };

  // 땡큐 활성 중 버린더미 드로우 차단 (표시된 카드는 땡큐 카드라 현재 플레이어가 가져갈 수 없음)
  if (source === 'discard' && game.thankYou.active) {
    return { ok: false, msg: '버린 더미를 사용할 수 없습니다' };
  }

  // 덱 드로우 시 땡큐 창 닫기
  if (source === 'deck' && game.thankYou.active && !game.thankYou.lock) {
    game.discardPile.push(game.thankYou.card);
    game.thankYou = { active: false, lock: null, card: null };
    game.discardPileHidden = true;
  }

  let card;
  if (source === 'discard') {
    if (game.firstTurn || game.discardPile.length === 0) return { ok: false, msg: '버린 더미를 사용할 수 없습니다' };
    card = game.discardPile.pop();
  } else {
    if (game.deck.length === 0) return { ok: false, msg: '덱이 비었습니다' };
    card = game.deck.pop();
  }

  player.hand.push(card);
  game.drawnCard = card;
  game.phase = 'action';
  if (source === 'deck' && game.deck.length === 0) game.lastDeckDraw = true;
  return { ok: true, card };
}

// Register a combo from hand
function registerCards(game, playerCode, cardIds) {
  const player = game.players.find(p => p.userCode === playerCode);
  if (!player) return { ok: false, msg: '플레이어 없음' };
  if (game.phase !== 'action') return { ok: false, msg: '행동 단계가 아닙니다' };
  if (getCurrentPlayer(game).userCode !== playerCode) return { ok: false, msg: '당신 차례가 아닙니다' };

  const cards = cardIds.map(id => player.hand.find(c => c.id === id)).filter(Boolean);
  if (cards.length !== cardIds.length) return { ok: false, msg: '카드를 찾을 수 없습니다' };
  if (!isValidCombo(cards)) return { ok: false, msg: '유효하지 않은 조합입니다' };

  const type = getComboType(cards);
  const combo = { id: `combo_${comboIdCounter++}`, ownerId: playerCode, cards, type };
  game.combos.push(combo);
  player.hand = player.hand.filter(c => !cardIds.includes(c.id));
  player.registered = true;

  // 땡큐로 가져온 카드를 등록에 사용했으면 취소 버튼 숨기기
  if (game.thankYouTakerCard && cardIds.includes(game.thankYouTakerCard.id)) {
    game.thankYouTaker = null;
    game.thankYouTakerCard = null;
  }

  if (player.hand.length === 0) return { ok: true, combo, win: true };
  return { ok: true, combo };
}

// Attach card(s) to existing combo
function attachCards(game, playerCode, cardIds, comboId) {
  const player = game.players.find(p => p.userCode === playerCode);
  if (!player) return { ok: false, msg: '플레이어 없음' };
  if (!player.registered) return { ok: false, msg: '먼저 등록을 완료해야 합니다' };
  if (game.phase !== 'action') return { ok: false, msg: '행동 단계가 아닙니다' };
  if (getCurrentPlayer(game).userCode !== playerCode) return { ok: false, msg: '당신 차례가 아닙니다' };

  const combo = game.combos.find(c => c.id === comboId);
  if (!combo) return { ok: false, msg: '조합을 찾을 수 없습니다' };

  for (const cardId of cardIds) {
    const card = player.hand.find(c => c.id === cardId);
    if (!card) return { ok: false, msg: `카드 ${cardId}를 찾을 수 없습니다` };
    if (!canAttach(combo, card)) return { ok: false, msg: '붙일 수 없는 카드입니다' };
    combo.type = getComboTypeAfterAttach(combo, card);
    combo.cards.push(card);
    player.hand = player.hand.filter(c => c.id !== cardId);
  }

  // 땡큐로 가져온 카드를 붙이기에 사용했으면 취소 버튼 숨기기
  if (game.thankYouTakerCard && cardIds.includes(game.thankYouTakerCard.id)) {
    game.thankYouTaker = null;
    game.thankYouTakerCard = null;
  }

  if (player.hand.length === 0) return { ok: true, win: true };
  return { ok: true };
}

// Discard a card
function discardCard(game, playerCode, cardId) {
  const player = game.players.find(p => p.userCode === playerCode);
  if (!player) return { ok: false, msg: '플레이어 없음' };
  if (game.phase !== 'action') return { ok: false, msg: '행동 단계가 아닙니다' };
  if (getCurrentPlayer(game).userCode !== playerCode) return { ok: false, msg: '당신 차례가 아닙니다' };

  const card = player.hand.find(c => c.id === cardId);
  if (!card) return { ok: false, msg: '카드를 찾을 수 없습니다' };

  // 땡큐 테이커는 땡큐 카드를 먼저 사용해야 버릴 수 있음
  if (game.thankYouTaker === playerCode && game.thankYouTakerCard) {
    if (player.hand.some(c => c.id === game.thankYouTakerCard.id)) {
      return { ok: false, msg: '땡큐 카드를 먼저 사용하거나 취소 버튼을 누르세요' };
    }
  }

  player.hand = player.hand.filter(c => c.id !== cardId);
  game.firstTurn = false;
  game.drawnCard = null;

  if (player.hand.length === 0) {
    // 패가 0장 → 즉시 승리 (버린더미에 올리기 전에 종료)
    game.discardPile.push(card);
    game.phase = 'draw';
    return { ok: true, card, win: true };
  }

  game.discardPileHidden = false;
  game.discardPile.push(card);
  game.phase = 'draw';
  return { ok: true, card };
}

// Auto-timeout: draw random + discard min
function autoTimeout(game) {
  const player = getCurrentPlayer(game);
  let drawnCard = null;

  // 땡큐 창이 열려있으면 닫기
  if (game.thankYou.active && !game.thankYou.lock) {
    game.discardPile.push(game.thankYou.card);
    game.thankYou = { active: false, lock: null, card: null, discarderCode: null };
    game.discardPileHidden = true;
  }

  if (game.phase === 'draw') {
    // random draw
    const useDiscard = !game.firstTurn && game.discardPile.length > 0 && Math.random() < 0.5;
    if (useDiscard) {
      drawnCard = game.discardPile.pop();
    } else {
      if (game.deck.length === 0) return { ok: false, deckEmpty: true };
      drawnCard = game.deck.pop();
      if (game.deck.length === 0) game.lastDeckDraw = true;
    }
    player.hand.push(drawnCard);
    game.phase = 'action';
  }

  // discard min value card
  const minCard = player.hand.reduce((min, c) => c.value < min.value ? c : min, player.hand[0]);
  player.hand = player.hand.filter(c => c.id !== minCard.id);
  game.discardPileHidden = false;
  game.discardPile.push(minCard);
  game.firstTurn = false;
  game.phase = 'draw';
  game.drawnCard = null;

  return { ok: true, drawnCard, discardedCard: minCard };
}

// Advance to next turn
function nextTurn(game, winnerCode = null) {
  if (winnerCode) {
    const winnerIdx = game.players.findIndex(p => p.userCode === winnerCode);
    game.turnIndex = (winnerIdx + 1) % game.players.length;
  } else {
    game.turnIndex = (game.turnIndex + 1) % game.players.length;
  }
  game.phase = 'draw';
  game.drawnCard = null;
  game.thankYouTaker = null;
  game.thankYouTakerCard = null;
  game.thankYouDisplacedTurnIndex = null;
  game.thankYouDisplacedDiscarder = null;
  game.lastDeckDraw = false;
}

// Thank you: lock
function tryThankYou(game, playerCode) {
  if (!game.thankYou.active) return { ok: false, msg: '땡큐 시간이 아닙니다' };
  if (game.thankYou.lock) return { ok: false, msg: '이미 누군가 땡큐했습니다' };
  if (game.thankYou.discarderCode === playerCode) return { ok: false, msg: '자신이 버린 카드는 땡큐할 수 없습니다' };
  game.thankYou.lock = playerCode;
  return { ok: true };
}

// Thank you: confirm (card taken, turn transferred)
function confirmThankYou(game, playerCode) {
  if (game.thankYou.lock !== playerCode) return { ok: false };
  const player = game.players.find(p => p.userCode === playerCode);
  const card = game.thankYou.card;
  player.hand.push(card);

  game.thankYouDisplacedTurnIndex = game.turnIndex;
  game.thankYouDisplacedDiscarder = game.thankYou.discarderCode;
  const playerIdx = game.players.findIndex(p => p.userCode === playerCode);
  game.turnIndex = playerIdx;
  game.phase = 'action';
  game.thankYouTaker = playerCode;
  game.thankYouTakerCard = card;
  game.thankYou = { active: false, lock: null, card: null, discarderCode: null };
  game.discardPileHidden = true;

  return { ok: true, card };
}

// Thank you: 확정 후 취소 (카드 반환 + 원래 차례로 복귀)
function cancelConfirmedThankYou(game, playerCode) {
  if (game.thankYouTaker !== playerCode) return { ok: false };
  const player = game.players.find(p => p.userCode === playerCode);
  const card = game.thankYouTakerCard;
  const discarderCode = game.thankYouDisplacedDiscarder;

  player.hand = player.hand.filter(c => c.id !== card.id);

  // 카드를 다시 버린 더미 맨 위로 올리고 땡큐 재활성화
  game.thankYou = { active: true, lock: null, card, discarderCode };

  game.thankYouTaker = null;
  game.thankYouTakerCard = null;
  game.thankYouDisplacedDiscarder = null;

  if (game.thankYouDisplacedTurnIndex != null) {
    game.turnIndex = game.thankYouDisplacedTurnIndex;
    game.thankYouDisplacedTurnIndex = null;
  }
  game.phase = 'draw';
  return { ok: true, card };
}

// Thank you: window 내 취소 (락만 된 상태)
function cancelThankYou(game, playerCode) {
  if (game.thankYou.lock !== playerCode) return { ok: false };
  const card = game.thankYou.card;
  game.discardPile.push(card);
  game.thankYou = { active: false, lock: null, card: null, discarderCode: null };
  return { ok: true, card };
}

// Activate thank you window after discard
function activateThankYou(game, card, discarderCode = null) {
  game.discardPile.pop();
  game.thankYou = { active: true, lock: null, card, discarderCode };
}

// Calculate final results
function calculateResults(game, winnerCode = null) {
  const results = game.players.map(p => {
    const cardSum = handScore(p.hand);
    return {
      userCode: p.userCode,
      userName: p.userName,
      isAI: p.isAI,
      avatar: p.avatar,
      hand: p.hand,
      cardSum,
      registered: p.registered,
      rank: 0,
      pointChange: 0
    };
  });

  // Determine ranks
  if (winnerCode) {
    results.forEach(r => { r.rank = r.userCode === winnerCode ? 1 : 2; });
    const effectivePay = r => r.cardSum * (r.registered ? 1 : 2);
    const losers = results.filter(r => r.rank === 2).sort((a, b) => {
      if (effectivePay(a) !== effectivePay(b)) return effectivePay(a) - effectivePay(b);
      return a.hand.length - b.hand.length;
    });
    let rank = 2;
    for (let i = 0; i < losers.length; i++) {
      if (i > 0 && effectivePay(losers[i]) === effectivePay(losers[i-1]) && losers[i].hand.length === losers[i-1].hand.length) {
        losers[i].rank = losers[i-1].rank;
      } else {
        losers[i].rank = rank;
      }
      rank++;
    }
  } else {
    // Deck exhausted: rank by effective payment (cardSum * multiplier), then hand count
    const effectivePay = r => r.cardSum * (r.registered ? 1 : 2);
    const sorted = [...results].sort((a, b) => {
      if (effectivePay(a) !== effectivePay(b)) return effectivePay(a) - effectivePay(b);
      return a.hand.length - b.hand.length;
    });
    let rank = 1;
    for (let i = 0; i < sorted.length; i++) {
      if (i > 0 && effectivePay(sorted[i]) === effectivePay(sorted[i-1]) && sorted[i].hand.length === sorted[i-1].hand.length) {
        sorted[i].rank = sorted[i-1].rank;
      } else {
        sorted[i].rank = rank;
      }
      rank++;
    }
    sorted.forEach(s => { results.find(r => r.userCode === s.userCode).rank = s.rank; });
  }

  const unit = game.mode === 'multi' ? 100 : 1;
  const winners = results.filter(r => r.rank === 1);

  // Calculate payments
  for (const r of results) {
    if (r.rank === 1) {
      let total = 0;
      for (const loser of results.filter(l => l.rank !== 1)) {
        const multiplier = loser.registered ? 1 : 2;
        total += loser.cardSum * unit * multiplier;
      }
      r.multiplier = 1;
      r.pointChange = total;
    } else {
      const multiplier = r.registered ? 1 : 2;
      r.multiplier = multiplier;
      r.pointChange = -(r.cardSum * unit * multiplier);
    }
    // 땡큐 취소 벌금/보상 합산
    r.thankYouChange = game.pendingChanges[r.userCode] || 0;
    if (r.thankYouChange) {
      r.pointChange += r.thankYouChange;
    }
  }

  return results;
}

module.exports = {
  createGame, getCurrentPlayer, getPublicState,
  drawCard, registerCards, attachCards, discardCard,
  autoTimeout, nextTurn,
  tryThankYou, confirmThankYou, cancelThankYou, cancelConfirmedThankYou, activateThankYou, // 이 부분 추가
  calculateResults
};
