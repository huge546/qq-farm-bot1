export {};

/**
 * 以薯换福（20261125）
 *
 * 抓包与字段依据见 docs/yishu-huanfu-20261125.md：
 *   - 分组 2026111707，主玩法 2026111708（type 26），任务位 2026111709（type 6）
 *   - 状态消息：ActivityData.field 130
 *   - operate_type 93 = 卖出蜜薯，载荷 field 193 = { count }
 *   - 蜜薯 = 道具 1032，福气币 = 道具 1033（走 ItemNotify）
 *
 * 目前只开放「卖出蜜薯」一个写操作，且仅供手动触发；领取、兑换、分享的
 * operate_type 尚未确认，确认前不写入自动流程。
 */

const { sendMsgAsync } = require('../utils/network');
const { types } = require('../utils/proto');
const { getServerTimeSec, toNum } = require('../utils/utils');
const { Reader } = require('protobufjs');

const GROUP_ID = '2026111707';
const MAIN_ID = '2026111708';
const TASK_ID = '2026111709';
const SELL_OPERATE_TYPE = 93;
const ITEM_ID_SWEET_POTATO = 1032;
const ITEM_ID_LUCK_COIN = 1033;
const MAX_SELL_COUNT = 100000;

let mutationTail: Promise<any> = Promise.resolve();

function fail(code: string, message: string): never {
    throw Object.assign(new Error(message), { code });
}

function parseRules(extra: unknown): string[] {
    if (!extra) return [];
    try {
        const buffer = Buffer.isBuffer(extra) ? extra : Buffer.from(String(extra), 'base64');
        const config = JSON.parse(buffer.toString('utf8'));
        const lines = config?.tips?.txt;
        return Array.isArray(lines) ? lines.map((line: unknown) => String(line)) : [];
    } catch {
        return [];
    }
}

function stateDto(state: any): any {
    if (!state) return null;
    return {
        // 445 = 福气币余额镜像，与道具 1033 实测一致。
        luckCoinBalance: toNum(state.luck_coin_balance),
        shop: state.shop ? {
            price: toNum(state.shop.field_1),
            tier: toNum(state.shop.field_2),
            refreshTime: toNum(state.shop.refresh_time) * 1000,
            status: toNum(state.shop.field_4),
        } : null,
        daily: state.daily ? {
            field_1: toNum(state.daily.field_1),
            field_2: toNum(state.daily.field_2),
            field_3: toNum(state.daily.field_3),
        } : null,
        flags: state.flags ? {
            field_1: toNum(state.flags.field_1),
            field_2: toNum(state.flags.field_2),
            field_3: toNum(state.flags.field_3),
        } : null,
        field_5: toNum(state.field_5),
        field_6: toNum(state.field_6),
        field_7: toNum(state.field_7),
    };
}

async function fetchActivity() {
    const body = types.ActivityListRequest.encode({ game_scene_id: 1 }).finish();
    const response = await sendMsgAsync('gamepb.activitypb.ActivityService', 'List', body);
    const reply = types.YiShuHuanFuListReply.decode(response.body);
    const group = (reply.groups || []).find((entry: any) => String(entry.head?.id) === GROUP_ID);
    if (!group) fail('YISHU_UNAVAILABLE', '以薯换福活动数据暂不可用');
    const main = (group.children || []).find((entry: any) => String(entry.head?.id) === MAIN_ID) || null;
    return { group, main };
}

async function getYiShuHuanFuActivity() {
    const { group, main } = await fetchActivity();
    const now = getServerTimeSec() * 1000;
    const startTime = toNum(group.head?.start_time) * 1000;
    const endTime = toNum(group.head?.end_time) * 1000;
    const active = now >= startTime && now < endTime;
    return {
        groupId: GROUP_ID,
        activityId: MAIN_ID,
        taskActivityId: TASK_ID,
        title: String(group.head?.name || '以薯换福'),
        serverTime: now,
        startTime,
        endTime,
        active,
        rules: parseRules(main?.head?.extra),
        state: stateDto(main?.state),
        items: {
            sweetPotato: ITEM_ID_SWEET_POTATO,
            luckCoin: ITEM_ID_LUCK_COIN,
        },
        sellOperateType: SELL_OPERATE_TYPE,
    };
}

async function performSell(count: number) {
    const activity = await getYiShuHuanFuActivity();
    if (!activity.active) fail('YISHU_ENDED', '以薯换福尚未开始或已经结束');
    const body = types.YiShuHuanFuSellRequest.encode({
        activity_id: MAIN_ID,
        operate_type: SELL_OPERATE_TYPE,
        params: { count },
    }).finish();
    const response = await sendMsgAsync('gamepb.activitypb.ActivityService', 'Operate', body);
    const reply = types.YiShuHuanFuOperateReply.decode(response.body);
    if (String(reply.activity_id) !== MAIN_ID || toNum(reply.operate_type) !== SELL_OPERATE_TYPE) {
        fail('YISHU_RESULT_UNKNOWN', '卖出回包未能确认，请刷新核对，勿重复提交');
    }
    const result = reply.result ? {
        count: toNum(reply.result.count),
        unitPrice: toNum(reply.result.unit_price),
        total: toNum(reply.result.total),
        dailyLimit: toNum(reply.result.daily_limit),
        luckCoinBalance: toNum(reply.result.luck_coin_balance),
    } : null;
    return { result, state: stateDto(reply.data?.state), activity };
}

function sellYishuHuanFuSweetPotato(rawCount: unknown) {
    const count = Math.floor(Number(rawCount));
    if (!Number.isFinite(count) || count <= 0) fail('INVALID_SELL_COUNT', '卖出数量必须是正整数');
    if (count > MAX_SELL_COUNT) fail('INVALID_SELL_COUNT', `卖出数量不能超过 ${MAX_SELL_COUNT}`);
    const pending = mutationTail.then(() => performSell(count));
    mutationTail = pending.catch(() => {});
    return pending;
}

function encodeVarint(value: number): number[] {
    const out: number[] = [];
    let rest = Math.floor(value);
    while (rest > 0x7f) {
        out.push((rest & 0x7f) | 0x80);
        rest = Math.floor(rest / 128);
    }
    out.push(rest & 0x7f);
    return out;
}

function encodeTag(fieldNo: number, wire: number): number[] {
    return encodeVarint(fieldNo * 8 + wire);
}

/**
 * 把任意 protobuf 字节尽力还原成「字段 -> 值」结构，用于破解未确认的 operate 回包。
 * 解析失败不影响调用方，原始 base64 一并返回。
 */
function dumpProto(buffer: Buffer, depth = 0): any {
    if (depth > 4) return { hex: buffer.toString('hex') };
    const reader = Reader.create(buffer);
    const fields: any[] = [];
    try {
        while (reader.pos < reader.len) {
            const tag = reader.uint32();
            const no = tag >>> 3;
            const wire = tag & 7;
            if (no === 0 || no > 4096) throw new Error(`bad field ${no}`);
            const entry: any = { no, wire };
            if (wire === 0) {
                entry.value = String(reader.uint64());
            } else if (wire === 1) {
                entry.value = String(reader.uint64());
            } else if (wire === 2) {
                const raw = reader.bytes();
                const buf = Buffer.from(raw);
                entry.len = buf.length;
                if (buf.length > 0 && buf.length <= 160) entry.hex = buf.toString('hex');
                const nested = buf.length > 1 ? dumpProto(buf, depth + 1) : null;
                if (Array.isArray(nested) && nested.length > 0) entry.nested = nested;
                else {
                    const text = buf.toString('utf8');
                    if (buf.length > 0 && /^[\x20-\x7e\u4e00-\u9fff]+$/.test(text)) entry.text = text;
                }
            } else if (wire === 5) {
                entry.value = String(reader.float());
            } else {
                return { hex: buffer.toString('hex'), note: `unsupported wire ${wire}` };
            }
            fields.push(entry);
        }
    } catch (error: any) {
        return { hex: buffer.toString('hex'), error: error?.message || String(error) };
    }
    return fields;
}

/**
 * 直接发一个 ActivityService.Operate，回包原样 dump。
 * 只用来确认 operate_type 语义，禁止在自动化流程里调用。
 */
async function probeYiShuHuanFu(rawOperateType: unknown, payloadHex?: unknown, payloadFieldNo?: unknown) {
    const operateType = Math.floor(Number(rawOperateType));
    if (!Number.isFinite(operateType) || operateType <= 0) fail('INVALID_OPERATE_TYPE', 'operate_type 必须是正整数');
    const bytes: number[] = [];
    bytes.push(...encodeTag(1, 0), ...encodeVarint(Number(MAIN_ID)));
    bytes.push(...encodeTag(2, 0), ...encodeVarint(operateType));
    const hex = typeof payloadHex === 'string' ? payloadHex.trim() : '';
    if (hex) {
        if (!/^([0-9a-fA-F]{2})+$/.test(hex)) fail('INVALID_PAYLOAD', 'payloadHex 必须是偶数长度的十六进制串');
        const payload = Buffer.from(hex, 'hex');
        const fieldNo = Number(payloadFieldNo) || (100 + operateType);
        bytes.push(...encodeTag(fieldNo, 2), ...encodeVarint(payload.length), ...payload);
    }
    const body = Buffer.from(bytes);
    const response = await sendMsgAsync('gamepb.activitypb.ActivityService', 'Operate', body);
    const reply = types.YiShuHuanFuOperateReply.decode(response.body);
    return {
        request: {
            activityId: MAIN_ID,
            operateType,
            payloadField: hex ? (Number(payloadFieldNo) || (100 + operateType)) : null,
            payloadHex: hex || null,
        },
        reply: {
            activityId: String(reply.activity_id || ''),
            operateType: toNum(reply.operate_type),
            state: stateDto(reply.data?.state),
            sellResult: reply.result ? {
                count: toNum(reply.result.count),
                unitPrice: toNum(reply.result.unit_price),
                total: toNum(reply.result.total),
                dailyLimit: toNum(reply.result.daily_limit),
                luckCoinBalance: toNum(reply.result.luck_coin_balance),
            } : null,
            rawBase64: Buffer.from(response.body).toString('base64'),
            dump: dumpProto(Buffer.from(response.body)),
        },
    };
}

module.exports = {
    getYiShuHuanFuActivity,
    sellYishuHuanFuSweetPotato,
    probeYiShuHuanFu,
};
