const assert = require('node:assert/strict');
const test = require('node:test');

const { createReloginReminderService } = require('../dist/runtime/relogin-reminder');

function createService(configs) {
    const sent = [];
    const store = {
        getOfflineReminderForAccount(accountId) {
            return configs[accountId] || null;
        },
    };
    const service = createReloginReminderService({
        store,
        sendPushooMessage: async (payload) => {
            sent.push(payload);
            return { ok: true };
        },
        log: () => {},
    });
    return { service, sent };
}

test('下线提醒按账号所属用户选择推送渠道', async () => {
    const { service, sent } = createService({
        1: {
            channel: 'webhook',
            endpoint: 'https://example.test/user-a',
            token: '',
            secret: '',
            title: 'A 的下线提醒',
            msg: 'A 下线了',
            offlineDeleteSec: 60,
        },
        2: {
            channel: 'webhook',
            endpoint: 'https://example.test/user-b',
            token: '',
            secret: '',
            title: 'B 的下线提醒',
            msg: 'B 下线了',
            offlineDeleteSec: 0,
        },
    });

    await service.triggerOfflineReminder({ accountId: '1', accountName: '账号A', reason: 'test' });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].endpoint, 'https://example.test/user-a');
    assert.match(sent[0].title, /A 的下线提醒/);
    assert.equal(service.getOfflineAutoDeleteMs('1'), 60000);
    assert.equal(service.getOfflineAutoDeleteMs('2'), Infinity);
});

test('用户未配置提醒渠道时不推送也不自动删除账号', async () => {
    const { service, sent } = createService({
        3: {
            channel: 'webhook',
            endpoint: '',
            token: '',
            secret: '',
            title: '账号下线提醒',
            msg: '账号下线',
            offlineDeleteSec: 0,
        },
    });

    await service.triggerOfflineReminder({ accountId: '3', accountName: '账号C', reason: 'test' });

    assert.equal(sent.length, 0);
    assert.equal(service.getOfflineAutoDeleteMs('3'), Infinity);
});
