const createDb = require('@databases/sqlite').default;
const { sql } = require('@databases/sqlite');
const path = require('path');

let db;

async function init() {
  db = createDb(path.join(__dirname, 'hula.db'));

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
      createdAt INTEGER DEFAULT (strftime('%s','now'))
    )
  `);

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
      playedAt INTEGER DEFAULT (strftime('%s','now'))
    )
  `);

  await db.query(sql`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  await db.query(sql`INSERT OR IGNORE INTO settings (key, value) VALUES ('entryCode', '1234')`);
  await db.query(sql`INSERT OR IGNORE INTO settings (key, value) VALUES ('adminPassword', 'dd291234')`);
  await db.query(sql`INSERT OR IGNORE INTO users (userCode, userName, isAdmin) VALUES ('dd', '관리자', 1)`);
}

async function getUser(userCode) {
  const rows = await db.query(sql`SELECT * FROM users WHERE userCode = ${userCode}`);
  return rows[0] || null;
}

async function createUser(userCode, userName, isAdmin = 0) {
  await db.query(sql`INSERT INTO users (userCode, userName, isAdmin) VALUES (${userCode}, ${userName}, ${isAdmin})`);
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

async function saveGameResult(gameId, mode, results) {
  for (const r of results) {
    if (r.isAI) continue;
    await db.query(sql`
      INSERT INTO game_results (gameId, mode, userCode, rank, cardSum, pointChange, didRegister)
      VALUES (${gameId}, ${mode}, ${r.userCode}, ${r.rank}, ${r.cardSum}, ${r.pointChange}, ${r.didRegister ? 1 : 0})
    `);
    if (mode === 'multi') {
      await db.query(sql`
        UPDATE users SET
          multiBalance = MAX(0, multiBalance + ${r.pointChange}),
          multiWins = multiWins + ${r.rank === 1 ? 1 : 0},
          multiGames = multiGames + 1
        WHERE userCode = ${r.userCode}
      `);
    } else {
      await db.query(sql`
        UPDATE users SET
          singlePoints = MAX(0, singlePoints + ${r.pointChange}),
          singleWins = singleWins + ${r.rank === 1 ? 1 : 0},
          singleGames = singleGames + 1
        WHERE userCode = ${r.userCode}
      `);
    }
  }
}

async function getUserCount() {
  const rows = await db.query(sql`SELECT COUNT(*) as cnt FROM users`);
  return rows[0]?.cnt || 0;
}

async function getMultiRanking() {
  return db.query(sql`
    SELECT userCode, userName, multiBalance, multiWins, multiGames
    FROM users
    ORDER BY multiBalance DESC, multiWins DESC
    LIMIT 20
  `);
}

async function getSingleRanking() {
  return db.query(sql`
    SELECT userCode, userName, singlePoints, singleWins, singleGames
    FROM users
    ORDER BY singlePoints DESC, singleWins DESC
    LIMIT 20
  `);
}

async function chargeBalance(userCode, mode) {
  const now = Date.now();
  const user = await getUser(userCode);
  if (!user) return { ok: false, msg: '유저 없음' };

  const lastKey = mode === 'multi' ? 'lastMultiCharge' : 'lastSingleCharge';
  const last = user[lastKey];
  if (now - last < 24 * 60 * 60 * 1000) {
    const remain = Math.ceil((24 * 60 * 60 * 1000 - (now - last)) / 3600000);
    return { ok: false, msg: `${remain}시간 후 충전 가능` };
  }

  const amount = mode === 'multi' ? 10000 : 100;
  if (mode === 'multi') {
    await db.query(sql`UPDATE users SET multiBalance = multiBalance + ${amount}, lastMultiCharge = ${now} WHERE userCode = ${userCode}`);
  } else {
    await db.query(sql`UPDATE users SET singlePoints = singlePoints + ${amount}, lastSingleCharge = ${now} WHERE userCode = ${userCode}`);
  }
  return { ok: true, amount };
}

module.exports = {
  init, getUser, createUser, updateUser, getAllUsers, deleteUser,
  getSetting, setSetting, saveGameResult,
  getMultiRanking, getSingleRanking, chargeBalance, getUserCount
};
