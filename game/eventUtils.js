// 주간 이벤트(최다승/최다판/최다훌라) 계산 로직 — 순수 함수, DB 접근 없음.
// "정산 배치" 없이, 매번 요청 시점 기준으로 현재 시각이 속한 주/그 직전 주 경계를 계산해서
// game_results를 그 구간으로 필터링하는 방식이라 별도 스케줄러가 필요 없다.

const { dayKeyKST, todayKeyKST } = require('./statsUtils');

const EVENT_ANCHOR_DOW = 4; // 이벤트 주 시작 요일: 목요일 (0=일,1=월,...,4=목,...,6=토)

// 이벤트 기능이 실제로 시작된 주(첫 배포일). 이 날짜보다 이전 주는 "지난 주 결과"로
// 절대 집계하지 않는다 — 안 그러면 기능 배포 전부터 쌓여있던 기존 게임 기록을 가지고
// 소급해서 "이미 우승/보상 확정"된 것처럼 보여주게 되어 사용자가 의도한 시작 시점과 어긋남.
const EVENT_LAUNCH_WEEK_KEY = '2026-07-23';

const EVENT_CATEGORIES = {
  winsSingle: { mode: 'single', metric: 'wins', minGames: 3, pointAmount: 1000, moneyAmount: 0, label: '최다승 · 싱글' },
  winsMulti: { mode: 'multi', metric: 'wins', minGames: 3, pointAmount: 0, moneyAmount: 50000, label: '최다승 · 멀티' },
  gamesSingle: { mode: 'single', metric: 'games', minGames: 3, pointAmount: 500, moneyAmount: 0, label: '최다판 · 싱글' },
  gamesMulti: { mode: 'multi', metric: 'games', minGames: 3, pointAmount: 0, moneyAmount: 25000, label: '최다판 · 멀티' },
  hula: { mode: 'combined', metric: 'hula', minGames: 3, pointAmount: 1000, moneyAmount: 50000, label: '최다훌라 · 합산' },
};

// sec 시각의 KST 요일 (0=일요일 ~ 6=토요일), 서버 로컬 타임존과 무관하게 항상 KST 기준
function kstDayOfWeek(sec) {
  return new Date(sec * 1000 + 9 * 3600 * 1000).getUTCDay();
}

// sec 시각이 속한 "이벤트 주"의 시작(그 주 목요일 0시 KST)을 유닉스초로 반환
function getWeekStartSec(sec) {
  const dow = kstDayOfWeek(sec);
  const diffDays = (dow - EVENT_ANCHOR_DOW + 7) % 7;
  const keyOfSec = dayKeyKST(sec);
  const kstMidnightUtcMs = Date.parse(keyOfSec + 'T00:00:00Z') - 9 * 3600 * 1000;
  return Math.floor(kstMidnightUtcMs / 1000) - diffDays * 86400;
}

// 지금(nowSec) 기준 "이번 주"와 "지난 주"의 경계값 일체를 반환
function getCurrentAndLastWeek(nowSec) {
  const currentStartSec = getWeekStartSec(nowSec);
  const currentEndSec = currentStartSec + 7 * 86400;
  const lastStartSec = currentStartSec - 7 * 86400;
  const lastEndSec = currentStartSec;
  const lastStartKey = dayKeyKST(lastStartSec);
  return {
    currentStartSec, currentEndSec,
    lastStartSec, lastEndSec,
    currentStartKey: dayKeyKST(currentStartSec),
    currentEndKey: dayKeyKST(currentEndSec - 1),
    lastStartKey,
    lastEndKey: dayKeyKST(lastEndSec - 1),
    nowKey: dayKeyKST(nowSec),
    // 첫 이벤트 주(EVENT_LAUNCH_WEEK_KEY) 진행 중에는 아직 "지난 주"가 존재하지 않음
    resultsAvailable: lastStartKey >= EVENT_LAUNCH_WEEK_KEY,
  };
}

// singleRows/multiRows(전체 유저, 전체 기간)를 [startSec,endSec) 구간으로 필터링해 유저별로 집계
function aggregateUsersInRange(singleRows, multiRows, startSec, endSec) {
  const stats = new Map();
  const ensure = uc => {
    if (!stats.has(uc)) stats.set(uc, { singleGames: 0, singleWins: 0, multiGames: 0, multiWins: 0, hula: 0 });
    return stats.get(uc);
  };
  for (const r of singleRows) {
    if (r.playedAt < startSec || r.playedAt >= endSec) continue;
    const s = ensure(r.userCode);
    s.singleGames++;
    if (r.rank === 1) s.singleWins++;
    if (r.isHula) s.hula++;
  }
  for (const r of multiRows) {
    if (r.playedAt < startSec || r.playedAt >= endSec) continue;
    const s = ensure(r.userCode);
    s.multiGames++;
    if (r.rank === 1) s.multiWins++;
    if (r.isHula) s.hula++;
  }
  return stats;
}

function valueFor(cfg, s) {
  if (cfg.mode === 'single') return { games: s.singleGames, value: cfg.metric === 'wins' ? s.singleWins : s.singleGames };
  if (cfg.mode === 'multi') return { games: s.multiGames, value: cfg.metric === 'wins' ? s.multiWins : s.multiGames };
  return { games: s.singleGames + s.multiGames, value: s.hula };
}

// 한 부문의 이번(지난) 주 1위(공동 포함)를 계산. 최소판수 미달이거나 1위 값이 0이면 winners=[]("해당자 없음")
function computeCategoryWinner(stats, categoryKey) {
  const cfg = EVENT_CATEGORIES[categoryKey];
  let bestValue = 0;
  let winners = [];
  for (const [userCode, s] of stats) {
    const { games, value } = valueFor(cfg, s);
    if (games < cfg.minGames) continue;
    if (value <= 0) continue;
    if (value > bestValue) { bestValue = value; winners = [userCode]; }
    else if (value === bestValue) { winners.push(userCode); }
  }
  return { winners, value: bestValue };
}

// 모든 부문에 대해 한 번에 winner 계산
function computeAllCategoryWinners(stats) {
  const out = {};
  for (const key of Object.keys(EVENT_CATEGORIES)) {
    out[key] = computeCategoryWinner(stats, key);
  }
  return out;
}

module.exports = {
  EVENT_ANCHOR_DOW, EVENT_CATEGORIES, EVENT_LAUNCH_WEEK_KEY,
  getWeekStartSec, getCurrentAndLastWeek,
  aggregateUsersInRange, computeCategoryWinner, computeAllCategoryWinners,
};
