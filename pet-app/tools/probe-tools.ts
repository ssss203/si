/**
 * probe-tools.ts —— 验证自定义工具（run_checks / git_status）能不能被肆调用。
 *
 * 它只问一句话：跑一次项目自检并汇报。如果肆真的调用了 run_checks 并念出真实结果，
 * 就说明"改完必须过检查"这条安全网接通了（阶段 F），同时 defineTool 这套机制也学会了（阶段 G）。
 *
 * 运行：
 *   cd F:\ss_yong\si\pet-si\pet-app
 *   $env:PET_PI_TOOLS='read,edit'
 *   npx tsx tools/probe-tools.ts
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { describeWorkspace, piChatStream } from '../src/main/pi-engine';

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
  console.log('（应该包含 run_checks 和 git_status）');
  console.log('========================================\n');

  const toolNames: string[] = [];
  const started = Date.now();
  const reply = await piChatStream({
    apiKey,
    model,
    systemPrompt,
    text: '用你的工具跑一次项目自检，然后用一句话汇报：通过还是失败？如果失败，第一条错误是什么？',
    history: [],
    onDelta: (delta) => process.stdout.write(delta),
    onEvent: (event) => {
      if (event.type === 'tool_execution_start') {
        toolNames.push(event.toolName ?? '未知');
        console.log(`\n[工具调用] ${event.toolName}`);
      }
    },
  });

  console.log(`\n\n耗时 ${Date.now() - started} ms`);
  console.log(`工具调用记录: ${toolNames.join(', ') || '（一次都没调）'}`);

  if (toolNames.includes('run_checks')) {
    console.log('✅ 它调用了 run_checks（自定义工具注册成功）');
  } else {
    console.log('❌ 它没有调用 run_checks —— 如果它的回答是"我没有执行工具"，那是白名单把自定义工具过滤了');
  }
}

void main().catch((error) => {
  console.error('\n[探针失败]');
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exitCode = 1;
});
