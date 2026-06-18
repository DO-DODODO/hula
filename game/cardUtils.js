const SUITS = ['S', 'H', 'D', 'C'];
const VALUES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
const VALUE_NAMES = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' };

function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const value of VALUES) {
      deck.push({ id: `${value}${suit}`, suit, value });
    }
  }
  return deck;
}

function shuffle(deck) {
  const d = [...deck];
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function cardName(card) {
  const v = VALUE_NAMES[card.value] || String(card.value);
  const s = { S: '♠', H: '♥', D: '♦', C: '♣' }[card.suit];
  return `${s}${v}`;
}

function cardScore(card) {
  return card.value;
}

function handScore(cards) {
  return cards.reduce((sum, c) => sum + cardScore(c), 0);
}

// Check if values form a consecutive circle (A wraps with K)
function isCircularConsecutive(values) {
  if (values.length < 2) return true;
  const sorted = [...values].sort((a, b) => a - b);

  // normal consecutive
  let normal = true;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] !== 1) { normal = false; break; }
  }
  if (normal) return true;

  // wraparound: exactly one gap that spans the A-K boundary
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i] - sorted[i - 1]);
  gaps.push(13 - sorted[sorted.length - 1] + sorted[0]); // wrap gap
  const nonOne = gaps.filter(g => g !== 1);
  return nonOne.length === 1;
}

function isValidSet(cards) {
  if (cards.length < 2) return false;
  const v = cards[0].value;
  if (!cards.every(c => c.value === v)) return false;
  if (cards.length === 2 && v !== 7) return false; // 7끼리 2장만 예외 허용
  return true;
}

function isValidSequence(cards) {
  if (cards.length < 3) return false;
  const suit = cards[0].suit;
  if (!cards.every(c => c.suit === suit)) return false;
  const values = cards.map(c => c.value);
  return isCircularConsecutive(values);
}

function isValidSeven(cards) {
  return cards.length === 1 && cards[0].value === 7;
}

function isValidCombo(cards) {
  return isValidSet(cards) || isValidSequence(cards) || isValidSeven(cards);
}

// Determine combo type after registration
function getComboType(cards) {
  if (isValidSeven(cards)) return 'seven';
  if (isValidSet(cards)) return 'set';
  if (isValidSequence(cards)) return 'sequence';
  return null;
}

// 같은 무늬 인접 숫자인지 (순환 포함)
function isSameSuitAdjacent(c1, c2) {
  if (c1.suit !== c2.suit) return false;
  const v1 = c1.value, v2 = c2.value;
  const diff = Math.abs(v1 - v2);
  return diff === 1 || (v1 === 1 && v2 === 13) || (v1 === 13 && v2 === 1);
}

// Check if newCard can be attached to existing combo
function canAttach(combo, newCard) {
  const cards = [...combo.cards, newCard];

  if (combo.type === 'seven') {
    if (combo.cards.length === 1) {
      // 단독 7에 첫 번째 카드 붙이기
      const base = combo.cards[0];
      if (newCard.value === base.value) return true;       // 세트 방향
      if (isSameSuitAdjacent(base, newCard)) return true;  // 시퀀스 방향
      return false;
    }
    // 2장 이상: 방향이 결정됐으나 type 아직 seven인 경우
    if (isValidSet(cards)) return true;
    if (isValidSequence(cards)) return true;
    return false;
  }

  if (combo.type === 'set') return isValidSet(cards);
  if (combo.type === 'sequence') return isValidSequence(cards);
  return false;
}

// Get combo type after attaching (for seven combos that evolve)
function getComboTypeAfterAttach(combo, newCard) {
  const cards = [...combo.cards, newCard];
  if (combo.type === 'seven') {
    if (combo.cards.length === 1) {
      const base = combo.cards[0];
      if (newCard.value === base.value) return 'set';
      if (isSameSuitAdjacent(base, newCard)) return 'sequence';
    }
    if (isValidSet(cards)) return 'set';
    if (isValidSequence(cards)) return 'sequence';
  }
  return combo.type;
}

module.exports = {
  createDeck, shuffle, cardName, cardScore, handScore,
  isValidCombo, getComboType, canAttach, getComboTypeAfterAttach,
  isValidSet, isValidSequence
};
