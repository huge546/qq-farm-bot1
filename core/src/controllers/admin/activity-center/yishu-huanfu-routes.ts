import type { Request } from 'express';
import type { ActivityRouteContext } from './types';

/**
 * 以薯换福（20261125）
 *
 * 第一版只开放只读状态和「手动卖出蜜薯」。
 * 领取、兑换、分享的 operate_type 尚未确认，确认前不提供接口。
 */
export function mountYiShuHuanFuRoutes({ app, ctx, withAccount, mountGet }: ActivityRouteContext): void {
    mountGet('/api/activity-center/yishu-huanfu', 'getYiShuHuanFuActivity');
    app.post('/api/activity-center/yishu-huanfu/sell', withAccount((accountId: string, req: Request) => (
        ctx.provider.sellYishuHuanFuSweetPotato(accountId, req.body?.count)
    )));
}
