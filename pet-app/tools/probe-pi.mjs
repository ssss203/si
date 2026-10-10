#!/usr/bin/env node
/**
 * probe-pi.mjs — 让 Pi 引擎用【桌宠自己的 key】跑起来。
 *
 * 和上一版的区别（这就是路线图的阶段 B）：
 *   1. 不再依赖 ~/.pi/agent/auth.json，改从桌宠自己的配置文件读 key：
 *      %APPDATA%\肆\coze-config.json  →  deepseekApiKey
 *   2. 做一层模型名映射：桌宠配置里写的是 deepseek-chat，
 *      但 pi 的模型目录里只有 deepseek-flash / deepseek-v4-pro。
 *   3. 故意把 authPath 指到一个不存在的文件，证明这一轮【完全】靠桌宠自己的 key。
 *
 * 依然只读：只用 read / grep / find / ls，不改任何项目文件。
 * 运行：
 *   chcp 65001
 *   node tools/probe-pi.mjs
 */
import { createAgentSession, ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const cwd = process.cwd();
const transcript = [];

function say(line = '') {
  transcript.push(`${line}\n`);
  console.log(line);
}

function maskKey(key) {
  if (typeof key !== 'string' || key.length < 8) return '(太短，可能不是有效 key)';
  return `${key.slice(0, 6)}...${key.slice(-4)} (长度 ${key.length})`;
}

// ---- 1) 读桌宠自己的配置 ----
const petConfigPath = path.join(process.env.APPDATA ?? '', '肆', 'coze-config.json');
let petConfig;
try {
  petConfig = JSON.parse(await readFile(petConfigPath, 'utf8'));
} catch (error) {
  console.error(`读不到桌宠配置: ${petConfigPath}`);
  console.error(`原因: ${error instanceof Error ? error.message : String(error)}`);
  console.error('先启动一次桌宠，让它把配置写出来。');
  process.exit(1);
}

const apiKey = petConfig.deepseekApiKey;
if (typeof apiKey !== 'string' || apiKey.length === 0) {
  console.error(`桌宠配置里没有 deepseekApiKey: ${petConfigPath}`);
  console.error('先在桌宠界面里填一次 API Key。');
  process.exit(1);
}

// ---- 2) 模型名映射：桌宠配置的 ID → pi 目录里的 ID ----
const MODEL_MAP = {
  'deepseek-chat': 'deepseek-flash',
  'deepseek-reasoner': 'deepseek-v4-pro',
  'deepseek-flash': 'deepseek-flash',
  'deepseek-v4-pro': 'deepseek-v4-pro',
};
const configuredModel = typeof petConfig.deepseekModel === 'string' ? petConfig.deepseekModel : 'deepseek-chat';
const piModelId = MODEL_MAP[configuredModel] ?? 'deepseek-flash';

// ---- 3) 用桌宠的 key 建 runtime（authPath 指向不存在的文件 = 没有兜底）----
const isolatedAuthPath = path.join(cwd, '.build', 'no-such-auth.json');
const modelRuntime = await ModelRuntime.create({ authPath: isolatedAuthPath });
await modelRuntime.setRuntimeApiKey('deepseek', apiKey);

let model = modelRuntime.getModel('deepseek', piModelId);
if (!model) {
  say(`⚠️ pi 目录里没有 ${piModelId}，退回可用列表第一个。`);
  const available = await modelRuntime.getAvailable();
  model = available[0];
}
if (!model) {
  console.error('没有任何可用模型：桌宠的 key 可能无效，或者 ModelsRuntime 没能加载模型目录。');
  process.exit(1);
}

say('========================================');
say(`key 来源    : ${petConfigPath}`);
say(`key         : ${maskKey(apiKey)}`);
say(`桌宠配置模型: ${configuredModel}`);
say(`映射到 pi   : ${model.provider}/${model.id}`);
say(`authPath    : ${isolatedAuthPath}（故意不存在，证明用的是桌宠的 key）`);
say(`工作目录    : ${cwd}`);
say(`只用工具    : read, grep, find, ls（只读）`);
say('========================================');

// ---- 4) 造会话 ----
const { session } = await createAgentSession({
  cwd,
  model,
  modelRuntime,
  tools: ['read', 'grep', 'find', 'ls'],
  sessionManager: SessionManager.inMemory(cwd),
});

let toolCallCount = 0;
const unsubscribe = session.subscribe((event) => {
  if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
    transcript.push(event.assistantMessageEvent.delta);
    process.stdout.write(event.assistantMessageEvent.delta);
  } else if (event.type === 'tool_execution_start') {
    toolCallCount += 1;
    say(`\n[工具调用 #${toolCallCount}] ${event.toolName}`);
  } else if (event.type === 'tool_execution_end') {
    let brief = '';
    try {
      brief = JSON.stringify(event.result).slice(0, 160);
    } catch {
      brief = '(结果无法序列化)';
    }
    say(`[工具结果] ${brief}`);
  }
});

try {
  say('\n--- 第一问：用桌宠自己的 key，它会不会说话 ---');
  await session.prompt('用一句中文介绍你自己，然后停下。');

  say('\n\n--- 第二问：它会不会动手 ---');
  await session.prompt('列出 tools 目录下的所有文件名，一行一个，用中文简短回答。');
  say('');
} catch (error) {
  say(`\n[出错了] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  if (typeof unsubscribe === 'function') unsubscribe();
  session.dispose();

  await mkdir(path.join(cwd, '.build'), { recursive: true });
  await writeFile(path.join(cwd, '.build', 'probe-pi.log'), transcript.join(''), 'utf8');

  say('========================================');
  say(`工具调用次数: ${toolCallCount}`);
  say(toolCallCount > 0
    ? '结论: 桌宠自己的 key 已经能驱动 Pi 引擎，而且它真的会调工具。'
    : '结论: 能说话但没调工具（把上面的输出发给我看）。');
  say('完整记录: .build/probe-pi.log');
  say('========================================');
}
