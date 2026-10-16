import type { Application, Request, Response } from 'express';
import type { AdminContext } from './context';
export {};

/**
 * 管理员：注册用户管理（查看 / 加时长 / 加账号额度 / 删除）
 */

const store = require('../../models/store');
const userStore = require('../../models/user-store');
const { createModuleLogger } = require('../../services/logger');

const { createAdminRequired, getAccountList } = require('./middleware');

const adminLogger = createModuleLogger('admin');

function mountUserRoutes(app: Application, ctx: AdminContext): void {
    const adminRequired = createAdminRequired(ctx);

    // API: 注册用户列表
    app.get('/api/admin/users', adminRequired, (_req: Request, res: Response) => {
        try {
            const users = userStore.listUsersForAdmin((userId: string) => getAccountList(ctx, userId).length);
            const stats = {
                total: users.length,
                active: users.filter((user: any) => !user.expired).length,
                expired: users.filter((user: any) => user.expired).length,
            };
            res.json({ ok: true, data: { users, stats } });
        } catch (e: any) {
            res.status(500).json({ ok: false, error: e && e.message ? e.message : '读取用户列表失败' });
        }
    });

    // API: 为用户增加会员时长
    app.post('/api/admin/users/:id/duration', adminRequired, (req: Request, res: Response) => {
        const days = Number.parseInt((req.body || {}).days, 10);
        if (!Number.isFinite(days) || days <= 0) {
            return res.status(400).json({ ok: false, error: '请输入大于 0 的天数' });
        }
        const result = userStore.setUserDuration(req.params.id, days);
        if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
        adminLogger.info('管理员为用户增加时长', { userId: req.params.id, days });
        return res.json({ ok: true, data: { userId: req.params.id, days } });
    });

    // API: 为用户增加账号额度
    app.post('/api/admin/users/:id/quota', adminRequired, (req: Request, res: Response) => {
        const accounts = Number.parseInt((req.body || {}).accounts, 10);
        if (!Number.isFinite(accounts) || accounts <= 0) {
            return res.status(400).json({ ok: false, error: '请输入大于 0 的额度数量' });
        }
        const result = userStore.addUserBonusAccounts(req.params.id, accounts);
        if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
        adminLogger.info('管理员为用户增加账号额度', { userId: req.params.id, accounts });
        return res.json({ ok: true, data: { bonusAccounts: result.bonusAccounts } });
    });

    // API: 删除注册用户（同时清理其名下账号）
    app.delete('/api/admin/users/:id', adminRequired, (req: Request, res: Response) => {
        try {
            const userId = String(req.params.id || '');
            const user = userStore.findUserById(userId);
            if (!user) return res.status(404).json({ ok: false, error: '用户不存在' });

            const removedAccounts: string[] = [];
            for (const account of getAccountList(ctx, userId)) {
                const accountId = String((account && account.id) || '');
                if (!accountId) continue;
                try {
                    if (ctx.provider && typeof ctx.provider.stopAccount === 'function') {
                        ctx.provider.stopAccount(accountId);
                    }
                    store.deleteAccount(accountId);
                    removedAccounts.push(accountId);
                } catch (e: any) {
                    adminLogger.warn('删除用户时清理账号失败', { userId, accountId, error: e && e.message });
                }
            }

            const result = userStore.deleteUser(userId);
            if (!result.ok) return res.status(400).json({ ok: false, error: result.error });

            adminLogger.info('管理员删除注册用户', { userId, username: user.username, removedAccounts: removedAccounts.length });
            return res.json({ ok: true, data: { userId, username: user.username, removedAccounts } });
        } catch (e: any) {
            return res.status(500).json({ ok: false, error: e && e.message ? e.message : '删除用户失败' });
        }
    });
}

module.exports = { mountUserRoutes };
