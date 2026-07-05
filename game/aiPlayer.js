const { isValidCombo, getComboType, canAttach, getComboTypeAfterAttach, handScore } = require('./cardUtils');

// Check if card is useful to AI hand
function isCardUseful(card, hand, existingCombos = [], playerRegistered = false) {
  // 등록 완료: 기존 조합에 붙이기 가능한지 확인
  if (playerRegistered) {
    for (const combo of existingCombos) {
      if (canAttach(combo, card)) return true;
    }
  }
  // runAITurn과 동일한 findCombos로 실제 등록 가능 여부 확인
  const testHand = [...hand, card];
  const combos = findCombos(testHand);
  return combos.some(cb => cb.cards.some(c => c.id === card.id));
}

// Find all valid combos in hand
function findCombos(hand) {
  const found = [];
  const n = hand.length;

  // Check all subsets of size 3+
  function check(indices) {
    const cards = indices.map(i => hand[i]);
    if (isValidCombo(cards)) {
      found.push({ indices, cards, type: getComboType(cards) });
    }
  }

  // Singles (7)
  for (let i = 0; i < n; i++) {
    if (hand[i].value === 7) found.push({ indices: [i], cards: [hand[i]], type: 'seven' });
  }

  // 7 두 장 세트
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (hand[i].value === 7 && hand[j].value === 7) {
        found.push({ indices: [i, j], cards: [hand[i], hand[j]], type: 'set' });
      }
    }
  }

  // Pairs + one more
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      for (let k = j + 1; k < n; k++) {
        check([i, j, k]);
        for (let l = k + 1; l < n; l++) {
          check([i, j, k, l]);
          for (let m = l + 1; m < n; m++) {
            check([i, j, k, l, m]);
          }
        }
      }
    }
  }

  // Deduplicate: prefer larger combos
  const unique = [];
  for (const c of found) {
    const key = c.cards.map(x => x.id).sort().join(',');
    if (!unique.find(u => u.cards.map(x => x.id).sort().join(',') === key)) {
      unique.push(c);
    }
  }
  return unique;
}

// Cards not used in any combo
function getUselessCards(hand, usedIndices) {
  return hand.filter((_, i) => !usedIndices.has(i));
}

function decideDraw(hand, discardTop) {
  if (!discardTop) return 'deck';
  return isCardUseful(discardTop, hand) ? 'discard' : 'deck';
}

function decideThankYou(card, hand) {
  return isCardUseful(card, hand);
}

function decideActions(hand, existingCombos, playerRegistered) {
  const actions = [];
  const combos = findCombos(hand);
  if (combos.length === 0) return actions;

  // Pick the best combo (largest first)
  combos.sort((a, b) => b.cards.length - a.cards.length);
  const best = combos[0];

  actions.push({ type: 'register', cards: best.cards });

  // Check if remaining hand cards can attach to any combo (own or others)
  const usedIds = new Set(best.cards.map(c => c.id));
  const remaining = hand.filter(c => !usedIds.has(c.id));

  for (const combo of existingCombos) {
    for (const card of remaining) {
      if (canAttach(combo, card)) {
        actions.push({ type: 'attach', card, comboId: combo.id });
      }
    }
  }

  return actions;
}

function decideAttach(hand, allCombos, playerRegistered) {
  if (!playerRegistered) return [];
  const actions = [];
  for (const combo of allCombos) {
    for (const card of hand) {
      if (canAttach(combo, card)) {
        actions.push({ type: 'attach', card, comboId: combo.id });
        break;
      }
    }
  }
  return actions;
}

const NEXT_VALUE = v => (v === 13 ? 1 : v + 1);
const PREV_VALUE = v => (v === 1 ? 13 : v - 1);

// 두 카드가 "1장만 더 오면 조합 완성"되는 페어인지 확인하고, 완성 카드 id 목록을 반환 (아니면 null)
function getPairCompletionIds(a, b) {
  const SUITS = ['S', 'H', 'D', 'C'];

  if (a.value === b.value) {
    // 세트 완성: 남은 무늬 카드
    return SUITS.filter(s => s !== a.suit && s !== b.suit).map(s => `${a.value}${s}`);
  }

  if (a.suit === b.suit) {
    // 인접 (양방향 확장 가능)
    if (NEXT_VALUE(a.value) === b.value || NEXT_VALUE(b.value) === a.value) {
      const [first, second] = NEXT_VALUE(a.value) === b.value ? [a.value, b.value] : [b.value, a.value];
      return [`${PREV_VALUE(first)}${a.suit}`, `${NEXT_VALUE(second)}${a.suit}`];
    }
    // 한 칸 띄기 (중간 카드 하나만 완성)
    if (NEXT_VALUE(NEXT_VALUE(a.value)) === b.value || NEXT_VALUE(NEXT_VALUE(b.value)) === a.value) {
      const first = NEXT_VALUE(NEXT_VALUE(a.value)) === b.value ? a.value : b.value;
      return [`${NEXT_VALUE(first)}${a.suit}`];
    }
  }

  return null;
}

function decideDiscard(hand, existingCombos = [], discardPile = []) {
  if (hand.length === 0) return null;
  const combos = findCombos(hand);
  const usedIds = new Set(combos.flatMap(c => c.cards.map(x => x.id)));
  const useless = hand.filter(c => !usedIds.has(c.id));
  const pool0 = useless.length > 0 ? useless : hand;

  // 이미 나온(죽은) 카드: 테이블에 등록된 조합 + 버린 카드 더미
  const deadIds = new Set([
    ...existingCombos.flatMap(c => c.cards.map(x => x.id)),
    ...discardPile.map(c => c.id),
  ]);

  // 1장만 더 오면 완성되는 살아있는 페어에 속한 카드는 보호
  const protectedIds = new Set();
  for (let i = 0; i < pool0.length; i++) {
    for (let j = i + 1; j < pool0.length; j++) {
      const completions = getPairCompletionIds(pool0[i], pool0[j]);
      if (!completions) continue;
      if (completions.some(id => !deadIds.has(id))) {
        protectedIds.add(pool0[i].id);
        protectedIds.add(pool0[j].id);
      }
    }
  }

  const candidates = pool0.filter(c => !protectedIds.has(c.id));
  const pool = candidates.length > 0 ? candidates : pool0;
  return pool.reduce((max, c) => c.value > max.value ? c : max, pool[0]);
}

module.exports = { decideDraw, decideThankYou, decideActions, decideAttach, decideDiscard, findCombos, isCardUseful };
