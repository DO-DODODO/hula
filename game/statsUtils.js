// 내 통계 화면 계산 로직 (game_results 원본 row만으로 계산, 새 컬럼은 continuedFromPrevious 하나뿐)

const SESSION_GAP_SEC = 600; // 10분 — 세션 끊김 기준(연속된 두 판 사이 간격)

function isSameSession(prevRow, curRow) {
  if (curRow.continuedFromPrevious !== null && curRow.continuedFromPrevious !== undefined) {
    return !!curRow.continuedFromPrevious;
  }
  return (curRow.playedAt - prevRow.playedAt) < SESSION_GAP_SEC;
}

// rows: playedAt 오름차순, { pointChange, rank, playedAt }
function computeMaxMinPointChange(rows) {
  if (rows.length === 0) return { maxGain: null, maxLoss: null };
  let maxGain = rows[0], maxLoss = rows[0];
  for (const r of rows) {
    if (r.pointChange > maxGain.pointChange) maxGain = r;
    if (r.pointChange < maxLoss.pointChange) maxLoss = r;
  }
  return {
    maxGain: { value: maxGain.pointChange, playedAt: maxGain.playedAt },
    maxLoss: { value: maxLoss.pointChange, playedAt: maxLoss.playedAt },
  };
}

// 연승/연패: 세션(끊기지 않고 이어친 구간) 단위로만 카운트, 세션 끊기면 리셋
function computeStreaks(rows) {
  let curWin = 0, curLose = 0;
  let curWinStart = null, curLoseStart = null;
  let bestWin = { count: 0, playedAt: null };
  let bestLose = { count: 0, playedAt: null };
  let prev = null;

  for (const r of rows) {
    const sameSession = prev ? isSameSession(prev, r) : false;
    if (!sameSession) { curWin = 0; curLose = 0; curWinStart = null; curLoseStart = null; }

    if (r.rank === 1) {
      curWin += 1;
      curLose = 0;
      if (curWin === 1) curWinStart = r.playedAt;
      if (curWin > bestWin.count) bestWin = { count: curWin, playedAt: curWinStart };
    } else {
      curLose += 1;
      curWin = 0;
      if (curLose === 1) curLoseStart = r.playedAt;
      if (curLose > bestLose.count) bestLose = { count: curLose, playedAt: curLoseStart };
    }
    prev = r;
  }
  return { maxWinStreak: bestWin, maxLoseStreak: bestLose };
}

// KST(UTC+9) 기준 YYYY-MM-DD 키
function dayKeyKST(playedAtSec) {
  const d = new Date(playedAtSec * 1000 + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

// 일자별 "그날 마지막 판 기준" 누적값 + 20판 이동평균 승률
function buildDailySeries(rows) {
  const map = new Map();
  let cumulative = 0;
  let winsSoFar = 0;
  for (let i = 0; i < rows.length; i++) {
    cumulative += rows[i].pointChange;
    if (rows[i].rank === 1) winsSoFar++;
    const winRate = Math.floor((winsSoFar / (i + 1)) * 1000) / 10;
    map.set(dayKeyKST(rows[i].playedAt), { cumulative, winRate });
  }
  return map;
}

function todayKeyKST() {
  return dayKeyKST(Math.floor(Date.now() / 1000));
}

// period: 'week' | 'month' | 'all'. 'all'이면 firstDayKey(가장 이른 데이터)부터 오늘까지
function getDateRangeKeys(period, firstDayKey) {
  const today = todayKeyKST();
  const days = period === 'week' ? 7 : period === 'month' ? 30 : null;
  const startKey = days
    ? dayKeyKST(Math.floor(Date.now() / 1000) - (days - 1) * 86400)
    : (firstDayKey || today);

  const keys = [];
  let cursor = new Date(startKey + 'T00:00:00Z');
  const end = new Date(today + 'T00:00:00Z');
  while (cursor <= end) {
    keys.push(cursor.toISOString().slice(0, 10));
    cursor = new Date(cursor.getTime() + 86400000);
  }
  return keys;
}

// dailyMap을 dateKeys에 맞춰 이월(carry-forward)해서 정렬 — 활동 없는 날은 직전 값 유지
function alignSeriesToDates(dailyMap, dateKeys, metric) {
  // 기간 시작일 이전에 이미 쌓인 마지막 값으로 초기화 (예: 1주일간 활동 없었어도 그 전까지의 누적값은 이어져야 함)
  let last = null;
  const firstKey = dateKeys[0];
  for (const k of [...dailyMap.keys()].sort()) {
    if (k >= firstKey) break;
    last = dailyMap.get(k)[metric];
  }
  return dateKeys.map(key => {
    if (dailyMap.has(key)) last = dailyMap.get(key)[metric];
    return { date: key, value: last };
  });
}

// 단일 유저 추이 시리즈 (나 탭에서 사용)
function buildTrendSeries(rows, period) {
  const dailyMap = buildDailySeries(rows);
  const firstDayKey = rows.length ? dayKeyKST(rows[0].playedAt) : todayKeyKST();
  const dateKeys = getDateRangeKeys(period, firstDayKey);
  return {
    cumulative: alignSeriesToDates(dailyMap, dateKeys, 'cumulative'),
    winRate: alignSeriesToDates(dailyMap, dateKeys, 'winRate'),
  };
}

// game_results의 pointChange 합만으로는 가입 시 기본 지급액/충전(chargeBalance)이 반영 안 되므로,
// 실제 현재 보유액(users 테이블)에 맞춰 시리즈 전체를 평행이동시켜 보정
function anchorToActualBalance(points, actualCurrent) {
  let lastVal = null;
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i].value !== null && points[i].value !== undefined) { lastVal = points[i].value; break; }
  }
  if (lastVal === null) return points.map(p => ({ ...p, value: p.value === null ? null : actualCurrent }));
  const offset = actualCurrent - lastVal;
  return points.map(p => ({ ...p, value: (p.value === null || p.value === undefined) ? null : p.value + offset }));
}

module.exports = {
  SESSION_GAP_SEC, isSameSession,
  computeMaxMinPointChange, computeStreaks,
  dayKeyKST, todayKeyKST, buildDailySeries, getDateRangeKeys, alignSeriesToDates,
  buildTrendSeries, anchorToActualBalance,
};
