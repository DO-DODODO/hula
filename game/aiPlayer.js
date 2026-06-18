const { isValidCombo, getComboType, canAttach, getComboTypeAfterAttach, handScore } = require('./cardUtils');

// Check if card is useful to AI hand
function isCardUseful(card, hand) {
  // Check if adding this card to hand creates or extends a potential combo
  for (let i = 0; i < hand.length; i++) {
    for (let j = i + 1; j < hand.length; j++) {
      if (isValidCombo([hand[i], hand[j], card])) return true;
    }
  }
  // 7 is always somewhat useful (solo register)
  if (card.value === 7) return true;
  return false;
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

function decideDiscard(hand) {
  // Discard highest value card that's not part of any potential combo
  const combos = findCombos(hand);
  const usedIds = new Set(combos.flatMap(c => c.cards.map(x => x.id)));
  const useless = hand.filter(c => !usedIds.has(c.id));
  const pool = useless.length > 0 ? useless : hand;
  return pool.reduce((max, c) => c.value > max.value ? c : max, pool[0]);
}

module.exports = { decideDraw, decideThankYou, decideActions, decideAttach, decideDiscard, findCombos, isCardUseful };
