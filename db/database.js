const createDb = require('@databases/sqlite').default;
const { sql } = require('@databases/sqlite');
const path = require('path');

let db;

async function init() {
  const dbPath = process.env.DATABASE_PATH || path.join(__dirname, 'hula.db');
  db = createDb(dbPath);

  await db.query(sql`
    CREATE TABLE IF NOT EXISTS users (
      userCode TEXT PRIMARY KEY,
      userName TEXT NOT NULL,
      singlePoints INTEGER DEFAULT 100,
      multiBalance INTEGER DEFAULT 1000000,
      lastSingleCharge INTEGER DEFAULT 0,
      lastMultiCharge INTEGER DEFAULT 0,
      winMessage TEXT DEFAULT '오예!',
      avatar TEXT DEFAULT 'person',
      isAdmin INTEGER DEFAULT 0,
      singleWins INTEGER DEFAULT 0,
      singleGames INTEGER DEFAULT 0,
      multiWins INTEGER DEFAULT 0,
      multiGames INTEGER DEFAULT 0,
      showOnline INTEGER DEFAULT 1,
      singleHulaWins INTEGER DEFAULT 0,
      multiHulaWins INTEGER DEFAULT 0,
      createdAt INTEGER DEFAULT (strftime('%s','now'))
    )
  `);
  try {
    await db.query(sql`ALTER TABLE users ADD COLUMN showOnline INTEGER DEFAULT 1`);
  } catch (e) { /* 이미 컬럼이 있으면 무시 (기존 DB 마이그레이션) */ }
  try {
    await db.query(sql`ALTER TABLE users ADD COLUMN singleHulaWins INTEGER DEFAULT 0`);
  } catch (e) { /* 이미 컬럼이 있으면 무시 */ }
  try {
    await db.query(sql`ALTER TABLE users ADD COLUMN multiHulaWins INTEGER DEFAULT 0`);
  } catch (e) { /* 이미 컬럼이 있으면 무시 */ }
  // 카드 뒷면 스킨: 역대 최고 보유량 기준으로 영구 잠금해제(A안)라 "역대 최고"를 별도 추적해야 함
  let addedPeakColumns = false;
  try {
    await db.query(sql`ALTER TABLE users ADD COLUMN selectedCardSkin TEXT DEFAULT 'basic'`);
  } catch (e) { /* 이미 컬럼이 있으면 무시 */ }
  try {
    await db.query(sql`ALTER TABLE users ADD COLUMN peakSinglePoints INTEGER DEFAULT 100`);
    addedPeakColumns = true;
  } catch (e) { /* 이미 컬럼이 있으면 무시 */ }
  try {
    await db.query(sql`ALTER TABLE users ADD COLUMN peakMultiBalance INTEGER DEFAULT 1000000`);
  } catch (e) { /* 이미 컬럼이 있으면 무시 */ }
  if (addedPeakColumns) {
    // 컬럼을 방금 새로 추가한 거면, 이미 존재하던 유저들의 역대 최고치를 현재 보유량 밑으로 내려가지 않게 보정
    await db.query(sql`UPDATE users SET peakSinglePoints = MAX(peakSinglePoints, singlePoints), peakMultiBalance = MAX(peakMultiBalance, multiBalance)`);
  }

  await db.query(sql`
    CREATE TABLE IF NOT EXISTS game_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gameId TEXT NOT NULL,
      mode TEXT NOT NULL,
      userCode TEXT NOT NULL,
      rank INTEGER NOT NULL,
      cardSum INTEGER NOT NULL,
      pointChange INTEGER NOT NULL,
      didRegister INTEGER DEFAULT 0,
      continuedFromPrevious INTEGER DEFAULT NULL,
      isHula INTEGER DEFAULT 0,
      playedAt INTEGER DEFAULT (strftime('%s','now'))
    )
  `);
  try {
    await db.query(sql`ALTER TABLE game_results ADD COLUMN continuedFromPrevious INTEGER DEFAULT NULL`);
  } catch (e) { /* 이미 컬럼이 있으면 무시 */ }
  try {
    await db.query(sql`ALTER TABLE game_results ADD COLUMN isHula INTEGER DEFAULT 0`);
  } catch (e) { /* 이미 컬럼이 있으면 무시 */ }

  await db.query(sql`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  // 주간 이벤트 보상 수령 기록 — game_results와 완전히 분리(게임 성적 통계에 영향 안 줌).
  // (userCode, weekStart, category) 조합이 곧 "수령 여부" 자체라 별도 플래그 불필요.
  // UNIQUE 제약을 DB 레벨에 걸어서, 더블클릭/여러 탭 등으로 거의 동시에 청구 요청이 와도
  // (조회 후 삽입 방식의 애플리케이션 레벨 체크만으로는 막을 수 없는 경합) 중복 지급이 절대 안 되게 함.
  await db.query(sql`
    CREATE TABLE IF NOT EXISTS event_rewards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userCode TEXT NOT NULL,
      weekStart TEXT NOT NULL,
      category TEXT NOT NULL,
      pointAmount INTEGER DEFAULT 0,
      moneyAmount INTEGER DEFAULT 0,
      claimedAt INTEGER DEFAULT (strftime('%s','now')),
      UNIQUE(userCode, weekStart, category)
    )
  `);

  await db.query(sql`INSERT OR IGNORE INTO settings (key, value) VALUES ('entryCode', '1234')`);
  await db.query(sql`INSERT OR IGNORE INTO settings (key, value) VALUES ('adminPassword', 'dd291234')`);
  await db.query(sql`INSERT OR IGNORE INTO users (userCode, userName, isAdmin) VALUES ('kkkyyy123', '관리자', 1)`);
}

async function getUser(userCode) {
  const rows = await db.query(sql`SELECT * FROM users WHERE userCode = ${userCode}`);
  return rows[0] || null;
}

async function createUser(userCode, userName, isAdmin = 0) {
  await db.query(sql`INSERT INTO users (userCode, userName, isAdmin, singlePoints, multiBalance) VALUES (${userCode}, ${userName}, ${isAdmin}, 100, 1000000)`);
}

async function updateUser(userCode, fields) {
  for (const [key, value] of Object.entries(fields)) {
    await db.query(sql`UPDATE users SET ${sql.ident(key)} = ${value} WHERE userCode = ${userCode}`);
  }
}

async function getAllUsers() {
  return db.query(sql`SELECT * FROM users ORDER BY createdAt ASC`);
}

async function deleteUser(userCode) {
  await db.query(sql`DELETE FROM users WHERE userCode = ${userCode}`);
}

async function getSetting(key) {
  const rows = await db.query(sql`SELECT value FROM settings WHERE key = ${key}`);
  return rows[0]?.value || null;
}

async function setSetting(key, value) {
  await db.query(sql`INSERT OR REPLACE INTO settings (key, value) VALUES (${key}, ${value})`);
}

async function saveGameResult(gameId, mode, results, isHula = false, continuedFromPrevious = null) {
  for (const r of results) {
    if (r.isAI) continue;
    const isHulaWinner = isHula && r.rank === 1;
    await db.query(sql`
      INSERT INTO game_results (gameId, mode, userCode, rank, cardSum, pointChange, didRegister, continuedFromPrevious, isHula)
      VALUES (${gameId}, ${mode}, ${r.userCode}, ${r.rank}, ${r.cardSum}, ${r.pointChange}, ${r.didRegister ? 1 : 0}, ${continuedFromPrevious === null ? null : (continuedFromPrevious ? 1 : 0)}, ${isHulaWinner ? 1 : 0})
    `);
    if (mode === 'multi') {
      await db.query(sql`
        UPDATE users SET
          multiBalance = MAX(0, multiBalance + ${r.pointChange}),
          peakMultiBalance = MAX(peakMultiBalance, MAX(0, multiBalance + ${r.pointChange})),
          multiWins = multiWins + ${r.rank === 1 ? 1 : 0},
          multiGames = multiGames + 1,
          multiHulaWins = multiHulaWins + ${isHulaWinner ? 1 : 0}
        WHERE userCode = ${r.userCode}
      `);
    } else {
      await db.query(sql`
        UPDATE users SET
          singlePoints = MAX(0, singlePoints + ${r.pointChange}),
          peakSinglePoints = MAX(peakSinglePoints, MAX(0, singlePoints + ${r.pointChange})),
          singleWins = singleWins + ${r.rank === 1 ? 1 : 0},
          singleGames = singleGames + 1,
          singleHulaWins = singleHulaWins + ${isHulaWinner ? 1 : 0}
        WHERE userCode = ${r.userCode}
      `);
    }
  }
}

async function getGameResultsForUser(userCode, mode) {
  return db.query(sql`
    SELECT pointChange, rank, playedAt, continuedFromPrevious
    FROM game_results
    WHERE userCode = ${userCode} AND mode = ${mode}
    ORDER BY playedAt ASC
  `);
}

async function getAllGameResults(mode) {
  return db.query(sql`
    SELECT userCode, pointChange, rank, playedAt, continuedFromPrevious, isHula
    FROM game_results
    WHERE mode = ${mode}
    ORDER BY userCode ASC, playedAt ASC
  `);
}

async function getUserCount() {
  const rows = await db.query(sql`SELECT COUNT(*) as cnt FROM users`);
  return rows[0]?.cnt || 0;
}

async function getMultiRanking() {
  return db.query(sql`
    SELECT userCode, userName, avatar, multiBalance, multiWins, multiGames
    FROM users
    ORDER BY multiBalance DESC,
             CAST(multiWins AS REAL) / CASE WHEN multiGames = 0 THEN 1 ELSE multiGames END DESC
    LIMIT 20
  `);
}

async function getSingleRanking() {
  return db.query(sql`
    SELECT userCode, userName, avatar, singlePoints, singleWins, singleGames
    FROM users
    ORDER BY singlePoints DESC,
             CAST(singleWins AS REAL) / CASE WHEN singleGames = 0 THEN 1 ELSE singleGames END DESC
    LIMIT 20
  `);
}

async function getHulaRanking() {
  return db.query(sql`
    SELECT userCode, userName, avatar, singleHulaWins, multiHulaWins,
           (singleHulaWins + multiHulaWins) AS hulaWins
    FROM users
    WHERE (singleHulaWins + multiHulaWins) > 0
    ORDER BY hulaWins DESC, userName ASC
    LIMIT 20
  `);
}

async function chargeBalance(userCode, mode) {
  const now = Date.now();
  const user = await getUser(userCode);
  if (!user) return { ok: false, msg: '유저 없음' };

  // 잔액/포인트가 0일 때만 충전 가능
  if (mode === 'multi' && user.multiBalance > 0) return { ok: false, msg: '멀티 잔액이 0원일 때만 충전 가능합니다' };
  if (mode === 'single' && user.singlePoints > 0) return { ok: false, msg: '싱글 포인트가 0점일 때만 충전 가능합니다' };

  const lastKey = mode === 'multi' ? 'lastMultiCharge' : 'lastSingleCharge';
  const last = user[lastKey];
  if (now - last < 24 * 60 * 60 * 1000) {
    const remain = Math.ceil((24 * 60 * 60 * 1000 - (now - last)) / 3600000);
    return { ok: false, msg: `${remain}시간 후 충전 가능` };
  }

  const amount = mode === 'multi' ? 10000 : 100;
  if (mode === 'multi') {
    await db.query(sql`UPDATE users SET multiBalance = multiBalance + ${amount}, peakMultiBalance = MAX(peakMultiBalance, multiBalance + ${amount}), lastMultiCharge = ${now} WHERE userCode = ${userCode}`);
  } else {
    await db.query(sql`UPDATE users SET singlePoints = singlePoints + ${amount}, peakSinglePoints = MAX(peakSinglePoints, singlePoints + ${amount}), lastSingleCharge = ${now} WHERE userCode = ${userCode}`);
  }
  return { ok: true, amount };
}

// 이번 주(weekStart)에 이 유저가 이미 받은 부문들 (Set으로 반환 — "받음" 여부 체크용)
async function getClaimedCategoriesForWeek(userCode, weekStart) {
  const rows = await db.query(sql`
    SELECT category FROM event_rewards WHERE userCode = ${userCode} AND weekStart = ${weekStart}
  `);
  return new Set(rows.map(r => r.category));
}

// 이벤트 보상 수령: 기록 남기고(game_results와 분리) 실제 잔액에 반영.
// 조회 후 삽입이 아니라 INSERT 자체를 시도해서 UNIQUE 제약 위반 여부로 "이미 받았는지"를 판단 —
// 거의 동시에 두 번 요청이 와도 DB 레벨에서 하나만 성공하는 게 보장됨(경합 조건 없음).
async function claimEventReward(userCode, weekStart, category, pointAmount, moneyAmount) {
  try {
    await db.query(sql`
      INSERT INTO event_rewards (userCode, weekStart, category, pointAmount, moneyAmount)
      VALUES (${userCode}, ${weekStart}, ${category}, ${pointAmount}, ${moneyAmount})
    `);
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT') return { ok: false, msg: '이미 받았습니다' };
    console.error('claimEventReward insert 실패(제약 위반 아님):', e);
    return { ok: false, msg: '오류가 발생했습니다' };
  }
  if (pointAmount) {
    await db.query(sql`UPDATE users SET singlePoints = singlePoints + ${pointAmount}, peakSinglePoints = MAX(peakSinglePoints, singlePoints + ${pointAmount}) WHERE userCode = ${userCode}`);
  }
  if (moneyAmount) {
    await db.query(sql`UPDATE users SET multiBalance = multiBalance + ${moneyAmount}, peakMultiBalance = MAX(peakMultiBalance, multiBalance + ${moneyAmount}) WHERE userCode = ${userCode}`);
  }
  return { ok: true };
}

module.exports = {
  init, getUser, createUser, updateUser, getAllUsers, deleteUser,
  getSetting, setSetting, saveGameResult,
  getMultiRanking, getSingleRanking, getHulaRanking, chargeBalance, getUserCount,
  getGameResultsForUser, getAllGameResults,
  getClaimedCategoriesForWeek, claimEventReward
};
