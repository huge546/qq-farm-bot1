/*
 * 把 ProxyPin / Chrome DevTools 导出的 HAR 中的 WebSocket 消息拆成独立帧文件，
 * 供 tools/decode-latest-protocols.js 直接消费。
 *
 * 游戏每一帧是完整的 gamepb.Message（Meta + body），所以必须一帧一个 .bin，
 * 不能把多个帧拼接进同一个文件。
 *
 * 用法:
 *   node tools/har-to-frames.js <capture.har> [输出目录] [选项]
 *
 * 选项:
 *   --prefix <前缀>       输出文件名前缀，默认 ws_
 *   --connection <序号>   只导出第 N 个 WebSocket 连接（从 0 开始），默认合并全部
 *   --help                显示帮助
 */
const fs = require('node:fs');
const path = require('node:path');

function usage() {
    console.log(`用法: node tools/har-to-frames.js <capture.har> [输出目录] [选项]

选项:
  --prefix <前缀>       输出文件名前缀，默认 ws_
  --connection <序号>   只导出第 N 个 WebSocket 连接（从 0 开始），默认合并全部
  --help                显示帮助

示例:
  node tools/har-to-frames.js capture.har ./frames
  node tools/har-to-frames.js capture.har ./frames --connection 0

导出后解码:
  pnpm -C core exec tsx ../tools/decode-latest-protocols.js ./frames gamepb.activitypb.ActivityService.List`);
}

function parseArgs(argv) {
    const positional = [];
    const options = { prefix: 'ws_', connection: null, help: false };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--help' || arg === '-h') {
            options.help = true;
        } else if (arg === '--prefix') {
            options.prefix = argv[++i] || 'ws_';
        } else if (arg === '--connection') {
            options.connection = Number(argv[++i]);
        } else {
            positional.push(arg);
        }
    }
    return { positional, options };
}

function decodeMessage(message) {
    const opcode = Number(message.opcode ?? 2);
    const raw = message.data ?? message.payload ?? '';
    if (Array.isArray(raw)) return { opcode, bytes: Buffer.from(raw) };
    const text = String(raw);
    // opcode 2 = binary（HAR 中以 base64 保存），opcode 1 = text（极少出现）
    return { opcode, bytes: Buffer.from(text, opcode === 1 ? 'utf8' : 'base64') };
}

function main() {
    const { positional, options } = parseArgs(process.argv.slice(2));
    if (options.help || positional.length === 0) {
        usage();
        process.exit(options.help ? 0 : 1);
    }

    const harPath = path.resolve(positional[0]);
    const outDir = path.resolve(
        positional[1] || path.join(path.dirname(harPath), 'frames'),
    );

    let har;
    try {
        har = JSON.parse(fs.readFileSync(harPath, 'utf8'));
    } catch (error) {
        console.error(`读取 HAR 失败: ${error.message}`);
        process.exit(2);
    }

    const entries = har?.log?.entries || [];
    if (entries.length === 0) {
        console.error('HAR 中没有 log.entries，确认文件是否完整');
        process.exit(2);
    }

    // 每个 entry 可能是一个 WebSocket 连接，按出现顺序编号
    const connections = [];
    for (const entry of entries) {
        const messages = entry?._webSocketMessages || entry?.webSocketMessages || [];
        if (messages.length) connections.push({ entry, messages });
    }

    if (connections.length === 0) {
        console.error('HAR 中没有 WebSocket 消息。导出时需勾选 WebSocket / 抓帧，并确认代理已解密 wss');
        process.exit(3);
    }

    const selected = options.connection === null || Number.isNaN(options.connection)
        ? connections
        : connections.filter((_, index) => index === options.connection);

    if (selected.length === 0) {
        console.error(`没有第 ${options.connection} 个 WebSocket 连接，共 ${connections.length} 个`);
        process.exit(4);
    }

    const frames = [];
    for (const connection of selected) {
        for (const message of connection.messages) {
            const decoded = decodeMessage(message);
            if (!decoded.bytes.length) continue;
            frames.push({ time: Number(message.time ?? 0), ...decoded });
        }
    }

    if (frames.length === 0) {
        console.error('WebSocket 连接里没有可用帧');
        process.exit(5);
    }

    frames.sort((a, b) => a.time - b.time);

    fs.mkdirSync(outDir, { recursive: true });
    let envelopeFrames = 0;
    let textFrames = 0;
    let totalBytes = 0;

    frames.forEach((frame, index) => {
        const name = `${options.prefix}${String(index + 1).padStart(6, '0')}.bin`;
        fs.writeFileSync(path.join(outDir, name), frame.bytes);
        totalBytes += frame.bytes.length;
        if (frame.opcode === 1) textFrames += 1;
        // gamepb.Message 的字段 1 是 Meta，wire type 2，首字节固定为 0x0A
        if (frame.bytes[0] === 0x0a) envelopeFrames += 1;
    });

    console.log(`WebSocket 连接: ${connections.length} 个${options.connection === null ? '' : `，已选择第 ${options.connection} 个`}`);
    console.log(`导出帧: ${frames.length}（二进制 ${frames.length - textFrames}，文本 ${textFrames}）`);
    console.log(`gamepb.Message 帧: ${envelopeFrames}/${frames.length}`);
    console.log(`总字节: ${totalBytes}`);
    console.log(`输出目录: ${outDir}`);

    if (envelopeFrames < frames.length) {
        console.warn(`警告: 有 ${frames.length - envelopeFrames} 帧首字节不是 0x0A，可能不是游戏业务帧（如 ping/文本），或 opcode 判断有误`);
    }
}

main();
