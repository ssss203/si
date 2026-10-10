/**
 * probe-persistence.ts —— 验证"肆的记忆"能不能跨进程/跨重启保留。
 *
 * 用法（必须分两次运行，每次都是一个全新的 Node 进程）：
 *   npx tsx tools/probe-persistence.ts remember   # 第一次：告诉它一个词
 *   npx tsx tools/probe-persistence.ts recall     # 第二次：问它那个词
 *
 * 第二次如果答对了，就说明会话是**存在磁盘上**的 —— 也就是桌宠重启后不会失忆。
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { piChatStream, describeChatSession } from '../src/main/pi-engine';

const mode = process.argv[2] === 'remember' ? 'remember' : 'recall';

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
  const systemPrompt = JSON.parse(await readFile(path.join(process.cwd(), 'role-card.json'), 'utf8'))
    .systemPrompt as string;

  const before = describeChatSession();
  console.log('========================================');
  console.log(`本次动作    : ${mode === 'remember' ? '告诉它一个词' : '问它那个词'}`);
  console.log(`会话目录    : ${before.sessionDir}`);
  console.log(`加载前会话  : ${before.sessionFile ?? '(本进程还没建会话)'}`);
  console.log('========================================');

  const text = mode === 'remember'
    ? '记住一个词：蓝莓。请用一句话确认你记住了。'
    : '我让你记住的那个词是什么？只回答那个词本身。';

  const reply = await piChatStream({
    apiKey,
    model,
    systemPrompt,
    text,
    history: [],
    onDelta: (delta) => process.stdout.write(delta),
  });

  const after = describeChatSession();
  console.log(`\n会话文件    : ${after.sessionFile ?? '(无)'}`);

  if (mode === 'recall') {
    const remembered = reply.text.includes('蓝莓');
    console.log(remembered
      ? '✅ 它记得 —— 跨进程持久化成功，重启不会失忆'
      : '❌ 它不记得 —— 持久化没生效（把上面输出发我）');
  }
}

void main().catch((error) => {
  console.error('\n[探针失败]');
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exitCode = 1;
});
