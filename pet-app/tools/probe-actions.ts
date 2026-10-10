/**
 * probe-actions.ts —— 验证「动作工具」（阶段 G）：肆能不能自己请求播放动画 / 说话 / 安排提醒。
 *
 * 它只验到"工具 → 事件"这一段（探针里没有 Electron 主进程，所以不会真的播动画）。
 * 真正的执行由 main.ts 的 onEvent 处理，那个在你的桌面版里验。
 *
 * 运行：
 *   cd F:\ss_yong\si\pet-si\pet-app
 *   npx tsx tools/probe-actions.ts
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { describeWorkspace, piChatStream, type EngineEvent } from '../src/main/pi-engine';

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
  const workspace = describeWorkspace();

  console.log('========================================');
  console.log(`开放工具: ${workspace.tools.join(', ')}`);
  console.log('（应该包含 play_animation / say / remind）');
  console.log('========================================\n');

  const toolCalls: string[] = [];
  const actions: EngineEvent[] = [];

  const reply = await piChatStream({
    apiKey,
    model,
    systemPrompt,
    text: '做三件事：① 播一个 happy 动画 ② 主动跟主人说一句鼓励的话 ③ 安排一个 5 分钟后的提醒"喝水"。然后一句话汇报你做了什么。',
    history: [],
    onDelta: (delta) => process.stdout.write(delta),
    onEvent: (event: EngineEvent) => {
      if (event.type === 'tool_execution_start') {
        toolCalls.push(event.toolName ?? '未知');
        console.log(`\n[工具调用] ${event.toolName}`);
      }
      if (event.type === 'action') {
        actions.push(event);
        console.log(`\n[动作请求] ${JSON.stringify(event)}`);
      }
    },
  });

  console.log('\n\n--- 结果 ---');
  console.log(`工具调用: ${toolCalls.join(', ') || '（无）'}`);
  console.log(`动作请求: ${actions.length} 条`);
  for (const action of actions) console.log(`  · ${JSON.stringify(action)}`);
  console.log(`答复长度: ${reply.text.length} 字`);

  const hasAnimation = actions.some((a) => a.action === 'play_animation');
  const hasSay = actions.some((a) => a.action === 'say');
  const hasRemind = actions.some((a) => a.action === 'remind');
  console.log('');
  console.log(hasAnimation ? '✅ 播放动画请求已发出' : '❌ 没有播放动画请求');
  console.log(hasSay ? '✅ 主动说话请求已发出' : '❌ 没有主动说话请求');
  console.log(hasRemind ? '✅ 安排提醒请求已发出' : '❌ 没有安排提醒请求');
}

void main().catch((error) => {
  console.error('\n[探针失败]');
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exitCode = 1;
});
