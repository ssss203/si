/**
 * probe-engine.ts —— 验证 src/main/pi-engine.ts 这个「外壳」能不能用。
 *
 * 它模仿 main.ts 的真实调用方式（同样的 key、同样的角色卡、同样的参数），
 * 但不碰任何项目文件，只打印结果。
 *
 * 运行：
 *   cd F:\ss_yong\si\pet-si\pet-app
 *   chcp 65001
 *   npx tsx tools/probe-engine.ts
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {
  piChatStream,
  piShortReply,
  resetPiChatSession,
  describeWorkspace,
} from '../src/main/pi-engine';

async function loadRoleCard(): Promise<string> {
  const file = path.join(process.cwd(), 'role-card.json');
  const parsed = JSON.parse(await readFile(file, 'utf8')) as { systemPrompt?: unknown };
  if (typeof parsed.systemPrompt !== 'string' || !parsed.systemPrompt.trim()) {
    throw new Error('role-card.json 里没有 systemPrompt 字段');
  }
  return parsed.systemPrompt;
}

async function loadPetConfig(): Promise<{ apiKey: string; model: string }> {
  const file = path.join(process.env.APPDATA ?? '', '肆', 'coze-config.json');
  const parsed = JSON.parse(await readFile(file, 'utf8')) as {
    deepseekApiKey?: unknown;
    deepseekModel?: unknown;
  };
  if (typeof parsed.deepseekApiKey !== 'string' || !parsed.deepseekApiKey) {
    throw new Error('桌宠配置里没有 deepseekApiKey');
  }
  return {
    apiKey: parsed.deepseekApiKey,
    model: typeof parsed.deepseekModel === 'string' ? parsed.deepseekModel : 'deepseek-chat',
  };
}

async function main(): Promise<void> {
  const { apiKey, model } = await loadPetConfig();
  const systemPrompt = await loadRoleCard();
  const workspace = describeWorkspace();

  console.log('========================================');
  console.log(`桌宠配置模型: ${model}`);
  console.log(`人设卡长度  : ${systemPrompt.length} 字`);
  console.log(`工作目录    : ${workspace.dir}`);
  console.log(`开放工具    : ${workspace.tools.join(', ') || '（无，只能说话）'}`);
  console.log('========================================');

  // ---- 测试 1：流式说话 ----
  console.log('\n--- 测试 1：piChatStream 逐字输出 ---');
  let firstDeltas = 0;
  const started1 = Date.now();
  const first = await piChatStream({
    apiKey,
    model,
    systemPrompt,
    text: '你好，用一句话介绍你自己。',
    history: [],
    onDelta: (delta) => {
      firstDeltas += 1;
      process.stdout.write(delta);
    },
  });
  console.log(`\n[${Date.now() - started1} ms / ${firstDeltas} 个增量 / 共 ${first.text.length} 字]`);

  // ---- 测试 2：常驻会话记不记得上下文 ----
  console.log('\n--- 测试 2：连续第二句（验证会话是常驻的）---');
  const started2 = Date.now();
  const second = await piChatStream({
    apiKey,
    model,
    systemPrompt,
    text: '我刚才跟你说了什么？一句话回答。',
    history: [],
    onDelta: (delta) => process.stdout.write(delta),
  });
  console.log(`\n[${Date.now() - started2} ms / ${second.text.length} 字]`);

  // ---- 测试 3：气泡短回复（照抄 main.ts 的调用）----
  console.log('\n--- 测试 3：piShortReply（互动气泡，8 秒超时）---');
  const started3 = Date.now();
  const bubble = await piShortReply({
    apiKey,
    model,
    systemPrompt,
    prompt: '主人刚才对你做了「摸摸头」。请用一句 20 字以内的话回应这次互动。符合你的人设，只输出这一句话，不要解释、不要换行。',
    signal: AbortSignal.timeout(8000),
  });
  console.log(`气泡内容: ${bubble}`);
  console.log(`[${Date.now() - started3} ms / 长度 ${bubble.length}（上限 60）]`);

  // ---- 测试 4：AbortSignal 能不能真的打断 ----
  console.log('\n--- 测试 4：中止（400ms 后 abort）---');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 400);
  const started4 = Date.now();
  try {
    const aborted = await piChatStream({
      apiKey,
      model,
      systemPrompt,
      text: '请从 1 数到 200，每个数字单独一行。',
      history: [],
      onDelta: () => { },
      signal: controller.signal,
    });
    console.log(`没有抛错，返回 ${aborted.text.length} 字，耗时 ${Date.now() - started4} ms`);
  } catch (error) {
    console.log(`被中止或报错: ${error instanceof Error ? error.message : String(error)}`);
    console.log(`耗时 ${Date.now() - started4} ms`);
  } finally {
    clearTimeout(timer);
  }

  // ---- 测试 5：开了只读工具之后，它能不能真的读到文件 ----
  console.log('\n--- 测试 5：它能不能真读文件（阶段 D 第一步）---');
  console.log('问题：念出 package.json 里 scripts.doctor 的原文（必须真读，不许猜）');
  const toolNames: string[] = [];
  const started5 = Date.now();
  const readReply = await piChatStream({
    apiKey,
    model,
    systemPrompt,
    text: '用你的工具打开 package.json，把 scripts 里 doctor 那一行的完整命令原文念给我，不要凭记忆猜。',
    history: [],
    onDelta: (delta) => process.stdout.write(delta),
    onEvent: (event) => {
      if (event.type === 'tool_execution_start') {
        toolNames.push(event.toolName ?? '未知');
        console.log(`\n[工具调用] ${event.toolName}`);
      }
    },
  });
  console.log(`\n[${Date.now() - started5} ms / 工具调用: ${toolNames.join(', ') || '一次都没调'}]`);
  if (toolNames.length === 0) {
    console.log('⚠️ 它没调工具 —— tools 可能没生效，把这段发给我');
  } else if (readReply.text.includes('tools/doctor.mjs')) {
    console.log('✅ 它答对了（原文含 tools/doctor.mjs）—— 说明它真的读了文件');
  } else {
    console.log('🤔 调了工具，但答案里没看到 tools/doctor.mjs，人工看一眼上面的输出');
  }

  await resetPiChatSession();
  console.log('\n=== 探针结束 ===');
}

void main().catch((error) => {
  console.error('\n[探针失败]');
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exitCode = 1;
});
