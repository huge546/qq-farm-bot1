import type { Application, Request, Response } from 'express';
import type { AdminContext } from './context';
export {};

/**
 * Account CRUD routes, account-logs, logs, and settings routes.
 */

const store = require('../../models/store');
const { addOrUpdateAccount, deleteAccount, countAccountsByUser } = store;
const { findAccountByRef } = require('../../services/account-resolver');
const { updateRuntimeConfig, getRuntimeConfig, getDefaultSystemConfig, getDevicePresets, getTimeZoneOptions } = require('../../config/config');
const userStore = require('../../models/user-store');

const {
    getAccId,
    getAccountIds,
    handleApiError,
    getAccountList,
    resolveAccId,
    getAuthSession,
    isUserOwnerOfAccount,
    createAdminRequired,
} = require('./middleware');

function mountAccountRoutes(app: Application, ctx: AdminContext): void {
    const adminRequired = createAdminRequired(ctx);

    // API: 璐﹀彿绠＄悊
    app.get('/api/accounts', (req: Request, res: Response) => {
        try {
            const session = getAuthSession(req);
            const isAdmin = session?.role === 'admin';
            const data = ctx.provider.getAccounts();
            const filtered = {
                ...data,
                accounts: isAdmin ? data.accounts : data.accounts.filter((a: any) => String(a.userId || '') === String(session?.userId || '')),
            };
            res.json({ ok: true, data: filtered });
        } catch (e: any) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 鏇存柊璐﹀彿澶囨敞锛堝吋瀹规棫鎺ュ彛锛?
    app.post('/api/account/remark', (req: Request, res: Response) => {
        try {
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const rawRef = body.id || body.accountId || body.uin || req.headers['x-account-id'];
            const accountList = getAccountList(ctx);
            const target = findAccountByRef(accountList, rawRef);
            if (!target || !target.id) {
                return res.status(404).json({ ok: false, error: 'Account not found' });
            }

            // 鏅€氱敤鎴峰彧鑳芥搷浣滆嚜宸辩殑璐﹀彿
            const session = getAuthSession(req);
            if (session && session.role === 'user' && !isUserOwnerOfAccount(session, target)) {
                return res.status(403).json({ ok: false, error: '鏃犳潈鎿嶄綔璇ヨ处鍙? });
            }

            const remark = String(body.remark !== undefined ? body.remark : body.name || '').trim();
            if (!remark) {
                return res.status(400).json({ ok: false, error: 'Missing remark' });
            }

            const accountId = String(target.id);
            const data = addOrUpdateAccount({ id: accountId, name: remark });
            if (ctx.provider && typeof ctx.provider.setRuntimeAccountName === 'function') {
                ctx.provider.setRuntimeAccountName(accountId, remark);
            }
            if (ctx.provider && ctx.provider.addAccountLog) {
                ctx.provider.addAccountLog('update', `鏇存柊璐﹀彿澶囨敞: ${remark}`, accountId, remark);
            }
            res.json({ ok: true, data });
        } catch (e: any) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.post('/api/accounts', (req: Request, res: Response) => {
        try {
            const rawBody = (req.body && typeof req.body === 'object') ? req.body : {};
            const requestedName = typeof rawBody.name === 'string' ? rawBody.name.trim() : '';
            const body = typeof rawBody.name === 'string' ? { ...rawBody, name: requestedName } : rawBody;
            if (!requestedName) {
                return res.status(400).json({ ok: false, error: '璐﹀彿澶囨敞涓嶈兘涓虹┖' });
            }
            const visibleAccounts = getAccountList(ctx);
            const remarkMatchedAccount = !body.id && requestedName
                ? visibleAccounts.find((account: any) => String(account.name || '').trim() === requestedName)
                : null;
            const isRemarkRelogin = !!remarkMatchedAccount;
            const updateRef = body.id || (remarkMatchedAccount && remarkMatchedAccount.id) || '';
            const isUpdate = !!updateRef;

            const session = getAuthSession(req);
            const isAdmin = session?.role === 'admin';

            // 鏅€氱敤鎴锋坊鍔犺处鍙凤細缁戝畾 userId 骞舵牎楠岄厤棰?
            let boundUserId = undefined;
            if (!isUpdate && !isAdmin && session?.userId) {
                const used = countAccountsByUser(session.userId);
                const quota = userStore.getQuota(session.userId, used);
                if (quota && quota.remaining <= 0) {
                    return res.status(400).json({ ok: false, error: `璐﹀彿鏁伴噺宸茶揪涓婇檺锛?{quota.maxAccounts}锛夛紝璇峰厬鎹㈠崱瀵嗗悗閲嶈瘯` });
                }
                boundUserId = session.userId;
            }

            const resolvedUpdateId = isUpdate ? resolveAccId(ctx, updateRef) : '';
            const payload = {
                ...(isUpdate ? { ...body, id: resolvedUpdateId || String(updateRef) } : body),
                ...(boundUserId ? { userId: boundUserId } : {}),
            };
            let wasRunning = false;
            if (isUpdate && ctx.provider.isAccountRunning) {
                wasRunning = ctx.provider.isAccountRunning(payload.id);
            }

            // 妫€鏌ユ槸鍚︿粎淇敼浜嗗娉ㄤ俊鎭?
            let onlyRemarkChanged = false;
            if (isUpdate) {
                const oldAccounts = ctx.provider.getAccounts();
                const oldAccount = oldAccounts.accounts.find((a: any) => a.id === payload.id);
                if (oldAccount) {
                    // 妫€鏌?payload 涓槸鍚﹀彧鍖呭惈 id 鍜?name 瀛楁
                    const payloadKeys = Object.keys(payload);
                    const onlyIdAndName = payloadKeys.length === 2 && payloadKeys.includes('id') && payloadKeys.includes('name');
                    if (onlyIdAndName) {
                        onlyRemarkChanged = true;
                    }
                }
            }

            const data = addOrUpdateAccount(payload);
            if (ctx.provider.addAccountLog) {
                const accountId = isUpdate ? String(payload.id) : String((data.accounts.at(-1) || {}).id || '');
                const accountName = payload.name || '';
                ctx.provider.addAccountLog(
                    isUpdate ? 'update' : 'add',
                    isRemarkRelogin
                        ? `閫氳繃澶囨敞閲嶆柊鐧诲綍璐﹀彿: ${accountName || accountId}`
                        : isUpdate ? `鏇存柊璐﹀彿: ${accountName || accountId}` : `娣诲姞璐﹀彿: ${accountName || accountId}`,
                    accountId,
                    accountName
                );
            }
            // 濡傛灉鏄柊澧烇紝鑷姩鍚姩
            if (!isUpdate) {
                const newAcc = data.accounts.at(-1);
                if (newAcc) ctx.provider.startAccount(newAcc.id);
            } else if (isRemarkRelogin) {
                // Adding with an existing remark is a relogin operation, including for stopped accounts.
                ctx.provider.restartAccount(payload.id);
            } else if (wasRunning && !onlyRemarkChanged) {
                // 濡傛灉鏄洿鏂帮紝涓斾箣鍓嶅湪杩愯锛屼笖涓嶆槸浠呬慨鏀瑰娉紝鍒欓噸鍚?
                ctx.provider.restartAccount(payload.id);
            }
            res.json({ ok: true, data });
        } catch (e: any) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.delete('/api/accounts/:id', (req: Request, res: Response) => {
        try {
            const resolvedId = resolveAccId(ctx, req.params.id) || String(req.params.id || '');

            const before = ctx.provider.getAccounts();
            const target = findAccountByRef(before.accounts || [], req.params.id);

            // 鏅€氱敤鎴峰彧鑳藉垹闄よ嚜宸辩殑璐﹀彿
            const session = getAuthSession(req);
            if (session && session.role === 'user' && !isUserOwnerOfAccount(session, target)) {
                return res.status(403).json({ ok: false, error: '鏃犳潈鎿嶄綔璇ヨ处鍙? });
            }

            ctx.provider.stopAccount(resolvedId);
            const data = deleteAccount(resolvedId);
            if (ctx.provider.addAccountLog) {
                ctx.provider.addAccountLog('delete', `鍒犻櫎璐﹀彿: ${(target && target.name) || req.params.id}`, resolvedId, target ? target.name : '');
            }
            res.json({ ok: true, data });
        } catch (e: any) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 璐﹀彿鏃ュ織
    app.get('/api/account-logs', (req: Request, res: Response) => {
        try {
            const limit = Number.parseInt(req.query.limit as string) || 100;
            let list: any[] = ctx.provider.getAccountLogs ? ctx.provider.getAccountLogs(limit) : [];
            if (!Array.isArray(list)) list = [];

            // 涓庡綋鍓?web 鍓嶇淇濇寔涓€鑷达細鐩存帴杩斿洖鏁扮粍
            res.json(list);
        } catch (e: any) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 鏃ュ織
    app.get('/api/logs', (req: Request, res: Response) => {
        const session = getAuthSession(req);
        const isAdmin = session?.role === 'admin';
        const queryAccountIdRaw = (req.query.accountId || '').toString().trim();
        const id = queryAccountIdRaw ? (queryAccountIdRaw === 'all' ? '' : resolveAccId(ctx, queryAccountIdRaw)) : getAccId(ctx, req);
        // 濡傛灉娌℃湁鎸囧畾璐﹀彿ID锛岃幏鍙栨墍鏈夎处鍙风殑鏃ュ織
        if (!id) {
            const accountIds = getAccountIds(ctx, isAdmin ? undefined : session?.userId);
            const allLogs: any[] = [];
            const options = {
                limit: Number.parseInt(req.query.limit as string) || 100,
                tag: req.query.tag || '',
                module: req.query.module || '',
                event: req.query.event || '',
                keyword: req.query.keyword || '',
                isWarn: req.query.isWarn,
                timeFrom: req.query.timeFrom || '',
                timeTo: req.query.timeTo || '',
            };

            for (const accId of accountIds) {
                const logs = ctx.provider.getLogs(accId, options);
                if (Array.isArray(logs)) {
                    allLogs.push(...logs);
                }
            }

            // 鎸夋椂闂存帓搴忓苟闄愬埗鏁伴噺
            allLogs.sort((a: any, b: any) => (b.time || 0) - (a.time || 0));
            const limitedLogs = allLogs.slice(0, options.limit);

            return res.json({ ok: true, data: limitedLogs });
        }

        // 鎸囧畾浜嗚处鍙稩D涓旈€氳繃鏉冮檺妫€鏌ワ紝杩斿洖璇ヨ处鍙风殑鏃ュ織
        const options = {
            limit: Number.parseInt(req.query.limit as string) || 100,
            tag: req.query.tag || '',
            module: req.query.module || '',
            event: req.query.event || '',
            keyword: req.query.keyword || '',
            isWarn: req.query.isWarn,
            timeFrom: req.query.timeFrom || '',
            timeTo: req.query.timeTo || '',
        };
        const list = ctx.provider.getLogs(id, options);
        res.json({ ok: true, data: list });
    });

    // API: 娓呯┖褰撳墠璐﹀彿杩愯鏃ュ織
    app.delete('/api/logs', (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) return res.status(400).json({ ok: false, error: 'Missing x-account-id' });

        try {
            const data = ctx.provider.clearLogs(id);

            if (ctx.io && ctx.provider && typeof ctx.provider.getLogs === 'function') {
                const accountLogs = ctx.provider.getLogs(id, { limit: 100 });
                ctx.io.to(`account:${id}`).emit('logs:snapshot', {
                    accountId: id,
                    logs: Array.isArray(accountLogs) ? accountLogs : [],
                });

                const allLogs = ctx.provider.getLogs('', { limit: 100 });
                ctx.io.to('account:all').emit('logs:snapshot', {
                    accountId: 'all',
                    logs: Array.isArray(allLogs) ? allLogs : [],
                });
            }

            res.json({ ok: true, data });
        } catch (e: any) {
            handleApiError(res, e);
        }
    });

    // API: 璁剧疆椤电粺涓€淇濆瓨锛堝崟娆″啓鍏ワ紱杩愯涓处鍙风瓑寰?worker revision ACK锛?
    app.post('/api/settings/save', async (req: Request, res: Response) => {
        const id = getAccId(ctx, req);
        if (!id) {
            return res.status(400).json({ ok: false, error: 'Missing x-account-id' });
        }

        try {
            const data = await ctx.provider.saveSettings(id, req.body || {});
            const unconfirmed = data && data.status === 'unconfirmed';
            res.status(unconfirmed ? 202 : 200).json({
                ok: !unconfirmed,
                saved: !!(data && data.saved),
                stopped: !!(data && data.status === 'stopped'),
                confirmed: !!(data && data.confirmed),
                unconfirmed: !!unconfirmed,
                status: data?.status,
                code: unconfirmed ? data.confirmationError?.code : undefined,
                error: unconfirmed ? (data.confirmationError?.message || '閰嶇疆宸蹭繚瀛橈紝浣?worker 灏氭湭纭搴旂敤') : undefined,
                data: data || {},
            });
        } catch (e: any) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 璁剧疆闈㈡澘涓婚
    app.post('/api/settings/theme', async (req: Request, res: Response) => {
        try {
            const theme = String((req.body || {}).theme || '');
            const data = await ctx.provider.setUITheme(theme);
            res.json({ ok: true, data: data || {} });
        } catch (e: any) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 淇濆瓨涓嬬嚎鎻愰啋閰嶇疆
    app.post('/api/settings/offline-reminder', async (req: Request, res: Response) => {
        try {
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const channel = String(body.channel || '').trim().toLowerCase();
            if (channel === 'dingtalk') {
                try {
                    const { buildDingTalkWebhook } = require('../../services/push');
                    buildDingTalkWebhook(body.endpoint, body.token, body.secret);
                } catch (error: any) {
                    return res.status(400).json({ ok: false, error: error?.message || '閽夐拤 Webhook 鍦板潃鏍煎紡鏃犳晥' });
                }
            }
            const data = store.setOfflineReminder ? store.setOfflineReminder(body) : {};
            res.json({ ok: true, data: data || {} });
        } catch (e: any) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 娴嬭瘯涓嬬嚎鎻愰啋鎺ㄩ€侊紙涓嶈惤鐩橈級
    app.post('/api/settings/offline-reminder/test', async (req: Request, res: Response) => {
        try {
            const saved = store.getOfflineReminder ? store.getOfflineReminder() : {};
            const body = (req.body && typeof req.body === 'object') ? req.body : {};
            const cfg = { ...(saved || {}), ...body };

            const channel = String(cfg.channel || '').trim().toLowerCase();
            const endpoint = String(cfg.endpoint || '').trim();
            const token = String(cfg.token || '').trim();
            const secret = String(cfg.secret || '').trim();
            const titleBase = String(cfg.title || '璐﹀彿涓嬬嚎鎻愰啋').trim();
            const msgBase = String(cfg.msg || '璐﹀彿涓嬬嚎').trim();

            if (!channel) {
                return res.status(400).json({ ok: false, error: '鎺ㄩ€佹笭閬撲笉鑳戒负绌? });
            }
            if (channel === 'webhook' && !endpoint) {
                return res.status(400).json({ ok: false, error: 'Webhook 娓犻亾闇€瑕佸～鍐欐帴鍙ｅ湴鍧€' });
            }
            if (channel === 'dingtalk' && !endpoint && !token) {
                return res.status(400).json({ ok: false, error: '閽夐拤娓犻亾闇€瑕佸～鍐?Webhook 鍦板潃' });
            }
            if (channel !== 'webhook' && channel !== 'dingtalk' && !token) {
                return res.status(400).json({ ok: false, error: '褰撳墠鎺ㄩ€佹笭閬撻渶瑕佸～鍐?Token' });
            }

            const now = new Date();
            const ts = now.toISOString().replace('T', ' ').slice(0, 19);
            const { sendPushooMessage } = require('../../services/push');
            const ret = await sendPushooMessage({
                channel,
                endpoint,
                token,
                secret,
                title: `${titleBase}锛堟祴璇曪級`,
                content: `${msgBase}\n\n杩欐槸涓€鏉′笅绾挎彁閱掓祴璇曟秷鎭€俓n鏃堕棿: ${ts}`,
            });

            if (!ret) {
                return res.status(400).json({ ok: false, error: '鎺ㄩ€佸け璐ワ細鏃犺繑鍥炵粨鏋? });
            }

            const isSuccess = ret.ok ||
                ret.code === 'ok' ||
                ret.code === '0' ||
                String(ret.msg || '').includes('鎴愬姛') ||
                String(ret.raw?.status || '').toLowerCase() === 'success';

            if (!isSuccess && ret.msg && !String(ret.msg).includes('鎴愬姛')) {
                return res.status(400).json({ ok: false, error: ret.msg || '鎺ㄩ€佸け璐?, data: ret });
            }
            return res.json({ ok: true, data: ret, message: ret.msg || '鎺ㄩ€佹垚鍔? });
        } catch (e: any) {
            return res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 鑾峰彇閰嶇疆
    app.get('/api/settings', async (req: Request, res: Response) => {
        try {
            const id = getAccId(ctx, req);
            // 鐩存帴浠庝富杩涚▼鐨?store 璇诲彇锛岀‘淇濆嵆浣胯处鍙锋湭杩愯涔熻兘鑾峰彇閰嶇疆
            const intervals = id ? store.getIntervals(id) : {};
            const strategy = id ? store.getPlantingStrategy(id) : null;
            const preferredSeed = id ? store.getPreferredSeed(id) : null;
            const friendQuietHours = id ? store.getFriendQuietHours(id) : null;
            const automation = id ? store.getAutomation(id) : {};
            const stealDelaySeconds = id && (typeof store.getStealDelaySeconds === 'function') ? store.getStealDelaySeconds(id) : 0;
            const plantOrderRandom = id && (typeof store.getPlantOrderRandom === 'function') ? store.getPlantOrderRandom(id) : false;
            const plantDelaySeconds = id && (typeof store.getPlantDelaySeconds === 'function') ? store.getPlantDelaySeconds(id) : 0;
            const fertilizerBuyOrganicCount = id && (typeof store.getFertilizerBuyOrganicCount === 'function') ? store.getFertilizerBuyOrganicCount(id) : 0;
            const fertilizerBuyOrganicThresholdHours = id && (typeof store.getFertilizerBuyOrganicThresholdHours === 'function') ? store.getFertilizerBuyOrganicThresholdHours(id) : 10;
            const fertilizerBuyNormalCount = id && (typeof store.getFertilizerBuyNormalCount === 'function') ? store.getFertilizerBuyNormalCount(id) : 0;
            const fertilizerBuyNormalThresholdHours = id && (typeof store.getFertilizerBuyNormalThresholdHours === 'function') ? store.getFertilizerBuyNormalThresholdHours(id) : 10;
            const fertilizerBuyCheckIntervalMinutes = id && (typeof store.getFertilizerBuyCheckIntervalMinutes === 'function') ? store.getFertilizerBuyCheckIntervalMinutes(id) : 30;
            const bagSeedPriority = id && (typeof store.getBagSeedPriority === 'function') ? store.getBagSeedPriority(id) : [];
            const bagSeedLandTypes = id && (typeof store.getBagSeedLandTypes === 'function') ? store.getBagSeedLandTypes(id) : {};
            const bagSeedFallbackStrategy = id && (typeof store.getBagSeedFallbackStrategy === 'function') ? store.getBagSeedFallbackStrategy(id) : 'level';
            const autoAcceptFriendMinLevel = id && (typeof store.getAutoAcceptFriendMinLevel === 'function') ? store.getAutoAcceptFriendMinLevel(id) : 0;
            const autoAcceptRequireOwnLevel = id && (typeof store.getAutoAcceptRequireOwnLevel === 'function') ? store.getAutoAcceptRequireOwnLevel(id) : false;
            const autoAcceptHarvestStealEnabled = id && (typeof store.getAutoAcceptHarvestStealEnabled === 'function') ? store.getAutoAcceptHarvestStealEnabled(id) : true;
            const autoAcceptHarvestStealHarvest = id && (typeof store.getAutoAcceptHarvestStealHarvest === 'function') ? store.getAutoAcceptHarvestStealHarvest(id) : 8;
            const autoAcceptHarvestStealSteal = id && (typeof store.getAutoAcceptHarvestStealSteal === 'function') ? store.getAutoAcceptHarvestStealSteal(id) : 1;
            const ui = store.getUI();
            const offlineReminder = store.getOfflineReminder
                ? store.getOfflineReminder()
                : { channel: 'webhook', endpoint: '', token: '', secret: '', title: '璐﹀彿涓嬬嚎鎻愰啋', msg: '璐﹀彿涓嬬嚎', offlineDeleteSec: 0 };
            res.json({ ok: true, data: { intervals, strategy, preferredSeed, friendQuietHours, automation, stealDelaySeconds, plantOrderRandom, plantDelaySeconds, fertilizerBuyOrganicCount, fertilizerBuyOrganicThresholdHours, fertilizerBuyNormalCount, fertilizerBuyNormalThresholdHours, fertilizerBuyCheckIntervalMinutes, bagSeedPriority, bagSeedLandTypes, bagSeedFallbackStrategy, autoAcceptFriendMinLevel, autoAcceptRequireOwnLevel, autoAcceptHarvestStealEnabled, autoAcceptHarvestStealHarvest, autoAcceptHarvestStealSteal, ui, offlineReminder } });
        } catch (e: any) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    // API: 鑾峰彇榛樿閰嶇疆
    app.get('/api/settings/default', (_req: Request, res: Response) => {
        try {
            const defaultConfig = store.getDefaultAccountConfig ? store.getDefaultAccountConfig() : null;
            if (!defaultConfig) {
                return res.status(500).json({ ok: false, error: '鏃犳硶鑾峰彇榛樿閰嶇疆' });
            }
            res.json({ ok: true, data: defaultConfig });
        } catch (e: any) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.get('/api/settings/device-presets', (_req: Request, res: Response) => {
        try {
            res.json({ ok: true, data: getDevicePresets() });
        } catch (e: any) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.get('/api/settings/system-config', adminRequired, (_req: Request, res: Response) => {
        try {
            res.json({
                ok: true,
                data: {
                    saved: store.getSystemConfig(),
                    default: getDefaultSystemConfig(),
                    current: getRuntimeConfig(),
                    timeZones: getTimeZoneOptions(),
                },
            });
        } catch (e: any) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.post('/api/settings/system-config', adminRequired, (req: Request, res: Response) => {
        try {
            const { serverUrl, clientVersion, platform, os, timeZone, deviceInfo } = req.body || {};
            const previous = getRuntimeConfig();
            const saved = store.setSystemConfig({ serverUrl, clientVersion, platform, os, timeZone, deviceInfo });
            updateRuntimeConfig(saved);
            if (ctx.provider && typeof ctx.provider.broadcastConfig === 'function') {
                ctx.provider.broadcastConfig('');
            }
            const transportChanged = previous.serverUrl !== saved.serverUrl
                || previous.clientVersion !== saved.clientVersion
                || previous.platform !== saved.platform
                || previous.os !== saved.os;
            if (transportChanged && ctx.provider && typeof ctx.provider.getAccounts === 'function'
                && typeof ctx.provider.isAccountRunning === 'function'
                && typeof ctx.provider.restartAccount === 'function') {
                const accounts = ctx.provider.getAccounts()?.accounts || [];
                for (const account of accounts) {
                    if (account?.id && ctx.provider.isAccountRunning(account.id)) {
                        ctx.provider.restartAccount(account.id);
                    }
                }
            }
            res.json({ ok: true, data: { saved, current: getRuntimeConfig() } });
        } catch (e: any) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });

    app.post('/api/settings/system-config/reset', adminRequired, (_req: Request, res: Response) => {
        try {
            const previous = getRuntimeConfig();
            const saved = getDefaultSystemConfig();
            store.setSystemConfig(saved);
            updateRuntimeConfig(saved);
            if (ctx.provider && typeof ctx.provider.broadcastConfig === 'function') {
                ctx.provider.broadcastConfig('');
            }
            const transportChanged = previous.serverUrl !== saved.serverUrl
                || previous.clientVersion !== saved.clientVersion
                || previous.platform !== saved.platform
                || previous.os !== saved.os;
            if (transportChanged && ctx.provider && typeof ctx.provider.getAccounts === 'function'
                && typeof ctx.provider.isAccountRunning === 'function'
                && typeof ctx.provider.restartAccount === 'function') {
                const accounts = ctx.provider.getAccounts()?.accounts || [];
                for (const account of accounts) {
                    if (account?.id && ctx.provider.isAccountRunning(account.id)) {
                        ctx.provider.restartAccount(account.id);
                    }
                }
            }
            res.json({ ok: true, data: { saved, current: getRuntimeConfig() } });
        } catch (e: any) {
            res.status(500).json({ ok: false, error: e.message });
        }
    });
}

module.exports = { mountAccountRoutes };
