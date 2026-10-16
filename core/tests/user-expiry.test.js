const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { after } = require('node:test');

const DAY = 86400 * 1000;
const DATA_DIR = path.join(__dirname, '..', 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const CARDS_FILE = path.join(DATA_DIR, 'cards.json');

const userStore = require('../dist/models/user-store');
const security = require('../dist/models/auth-security');

function readIfExists(file) {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return null;
    }
}

function restore(file, content) {
    if (content === null) {
        fs.rmSync(file, { force: true });
        return;
    }
    fs.writeFileSync(file, content, 'utf8');
}

const savedUsers = readIfExists(USERS_FILE);
const savedCards = readIfExists(CARDS_FILE);

after(() => {
    restore(USERS_FILE, savedUsers);
    restore(CARDS_FILE, savedCards);
});

function setFixture(users, cards) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(USERS_FILE, JSON.stringify({ users }, null, 2), 'utf8');
    fs.writeFileSync(CARDS_FILE, JSON.stringify({ cards }, null, 2), 'utf8');
}

function makeUser(over = {}) {
    return {
        id: 'u_test',
        username: 'tester',
        password: security.hashPassword('Passw0rd!'),
        role: 'user',
        createdAt: 1,
        updatedAt: 1,
        cards: [],
        durationEnd: 0,
        ...over,
    };
}

function makeCard(over = {}) {
    return {
        code: 'AAAA-BBBB-CCCC-DDDD',
        type: 'duration',
        maxAccounts: 0,
        days: 30,
        createdAt: 1,
        redeemedBy: null,
        redeemedAt: null,
        status: 'active',
        ...over,
    };
}

test('时长卡未到期时不算到期', () => {
    const now = Date.now();
    setFixture(
        [makeUser({ id: 'u_active', cards: ['AAAA-BBBB-CCCC-DDDD'], durationEnd: now + 5 * DAY })],
        [makeCard({ redeemedBy: 'u_active', redeemedAt: now - DAY })],
    );
    assert.equal(userStore.isUserIdExpired('u_active'), false);
    assert.equal(userStore.getQuota('u_active', 0).expired, false);
    assert.equal(userStore.getQuota('u_active', 0).durationActive, true);
});

test('时长卡已过期即判定到期', () => {
    const now = Date.now();
    setFixture(
        [makeUser({ id: 'u_expired', cards: ['AAAA-BBBB-CCCC-DDDD'], durationEnd: now - DAY })],
        [makeCard({ redeemedBy: 'u_expired', redeemedAt: now - 31 * DAY })],
    );
    assert.equal(userStore.isUserIdExpired('u_expired'), true);
    assert.equal(userStore.getQuota('u_expired', 0).expired, true);
    assert.equal(userStore.getQuota('u_expired', 0).durationActive, false);
});

test('旧版本把 durationEnd 清零过的到期用户仍能识别', () => {
    const now = Date.now();
    setFixture(
        [makeUser({ id: 'u_zeroed', cards: ['AAAA-BBBB-CCCC-DDDD'], durationEnd: 0 })],
        [makeCard({ redeemedBy: 'u_zeroed', redeemedAt: now - 31 * DAY })],
    );
    assert.equal(userStore.isUserIdExpired('u_zeroed'), true);
});

test('只持有账户额度卡的用户不会被判为到期', () => {
    setFixture(
        [makeUser({ id: 'u_account', cards: ['EEEE-FFFF-GGGG-HHHH'], durationEnd: 0 })],
        [makeCard({ code: 'EEEE-FFFF-GGGG-HHHH', type: 'account', maxAccounts: 3, days: 0, redeemedBy: 'u_account', redeemedAt: Date.now() })],
    );
    assert.equal(userStore.isUserIdExpired('u_account'), false);
    assert.equal(userStore.getQuota('u_account', 0).expired, false);
});

test('getExpiredUserIds 只返回到期的用户', () => {
    const now = Date.now();
    setFixture(
        [
            makeUser({ id: 'u_a', username: 'a', cards: ['AAAA-BBBB-CCCC-DDDD'], durationEnd: now - DAY }),
            makeUser({ id: 'u_b', username: 'b', cards: ['AAAA-BBBB-CCCC-DDDD'], durationEnd: now + DAY }),
            makeUser({ id: 'u_c', username: 'c', cards: ['EEEE-FFFF-GGGG-HHHH'], durationEnd: 0 }),
        ],
        [
            makeCard({ redeemedBy: 'u_a', redeemedAt: now - 31 * DAY }),
            makeCard({ code: 'EEEE-FFFF-GGGG-HHHH', type: 'account', maxAccounts: 1, days: 0, redeemedBy: 'u_c', redeemedAt: now }),
        ],
    );
    assert.deepEqual([...userStore.getExpiredUserIds()], ['u_a']);
});

test('到期用户仍可登录，但会被配额接口标记为已到期', () => {
    const now = Date.now();
    setFixture(
        [makeUser({ id: 'u_expired', username: 'expired', cards: ['AAAA-BBBB-CCCC-DDDD'], durationEnd: now - DAY })],
        [makeCard({ redeemedBy: 'u_expired', redeemedAt: now - 31 * DAY })],
    );
    const login = userStore.verifyLogin('expired', 'Passw0rd!');
    assert.equal(login.ok, true);
    assert.equal(userStore.getQuota(login.user.id, 0).expired, true);
});

test('续费后不再判为到期', () => {
    const now = Date.now();
    setFixture(
        [makeUser({ id: 'u_renew', cards: ['AAAA-BBBB-CCCC-DDDD'], durationEnd: now - DAY })],
        [makeCard({ redeemedBy: 'u_renew', redeemedAt: now - 31 * DAY })],
    );
    assert.equal(userStore.isUserIdExpired('u_renew'), true);

    const extend = userStore.setUserDuration('u_renew', 30);
    assert.equal(extend.ok, true);
    assert.equal(userStore.isUserIdExpired('u_renew'), false);
    assert.equal(userStore.getQuota('u_renew', 0).durationActive, true);
});
