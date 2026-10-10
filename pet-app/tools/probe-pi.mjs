#!/usr/bin/env node
/**
 * probe-pi.mjs — 在桌宠项目里第一次启动 Pi 引擎。
 *
 * 这是一个「只读探针」：
 *   - 复用 ~/.pi/agent/auth.json 里你已有的 DeepSeek 配置
 *   - 只开放 read / grep / find / ls 四个只读工具（这一轮不允许改任何文件）
 *   - 不改任何项目文件，过程写到 .build/probe-pi.log（.build/ 已被 gitignore）
 *
 * 运行：
 *   chcp 65001      # 让控制台用 UTF-8，中文才不乱码（可选但推荐）
 *   node tools/probe-pi.mjs
 */
import { createAgentSession, ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const cwd = process.cwd();
const transcript = [];

function say(line = '') {
  transcript.push(`${line}\n`);
  console.log(line);
}

// ---- 1) 模型：优先 deepseek-flash，其次 deepseek-v4-pro，都不会用就退到可用列表第一个 ----
const modelRuntime = await ModelRuntime.create();
const preferred = ['deepseek-flash', 'deepseek-v4-pro'];
let model = null;
for (const id of preferred) {
  const candidate = modelRuntime.getModel('deepseek', id);
  if (candidate) {
    model = candidate;
    break;
  }
}

if (!model) {
  const available = await modelRuntime.getAvailable();
  say('没有找到 deepseek-flash / deepseek-v4-pro，退到可用列表第一个。');
  say(`可用模型: ${available.map((item) => `${item.provider}/${item.id}`).join(', ') || '(空)'}`);
  model = available[0];
}
if (!model) {
  console.error('没有任何可用模型。先确认 ~/.pi/agent/auth.json 里的 key 还在。');
  process.exit(1);
}

say('========================================');
say(`模型      : ${model.provider}/${model.id}`);
say(`工作目录  : ${cwd}`);
say(`只用工具  : read, grep, find, ls（只读）`);
say('========================================');

// ---- 2) 造会话 ----
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
    const delta = event.assistantMessageEvent.delta;
    transcript.push(delta);
    process.stdout.write(delta);
  } else if (event.type === 'tool_execution_start') {
    toolCallCount += 1;
    say(`\n[工具调用 #${toolCallCount}] ${event.toolName}`);
  } else if (event.type === 'tool_execution_end') {
    let brief = '';
    try {
      brief = JSON.stringify(event.result).slice(0, 220);
    } catch {
      brief = '(结果无法序列化)';
    }
    say(`[工具结果] ${brief}`);
  }
});

try {
  // ---- 3) 第一问：它会不会说话 ----
  say('\n--- 第一问：会不会说话 ---');
  await session.prompt('用一句中文介绍你自己，然后停下。');

  // ---- 4) 第二问：它会不会动手 ----
  say('\n\n--- 第二问：会不会动手（这是"接上 Pi"的关键一步）---');
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
    ? '结论: Pi 引擎在你的项目里跑起来了，而且真的会调工具。'
    : '结论: Pi 能说话，但这一轮没调工具（把上面的输出发给我看看）。');
  say('完整记录: .build/probe-pi.log');
  say('========================================');
}
