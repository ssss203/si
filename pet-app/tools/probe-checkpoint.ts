/**
 * probe-checkpoint.ts —— 验证阶段 E 的自动存档 + 撤回 + 受保护路径。
 *
 * 它会做一件真实但有退路的事：让肆用 edit 工具改一个**被 git 跟踪的练习靶子**
 * （qa/manual-checklist.md），然后：
 *   1. 检查存档记录有没有写下来
 *   2. 检查文件是不是真被改了
 *   3. 调用撤回，检查文件是不是原样回来了
 * 最后再验证受保护路径的拦截函数。
 *
 * 运行（注意环境变量要在一行里设，它决定这一轮开放哪些工具）：
 *   cd F:\ss_yong\si\pet-si\pet-app
 *   $env:PET_PI_TOOLS='read,edit'
 *   npx tsx tools/probe-checkpoint.ts
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { piChatStream, resetPiChatSession, describeWorkspace } from '../src/main/pi-engine';
import {
  isProtectedPath,
  readLatestCheckpoint,
  restoreLatestCheckpoint,
} from '../src/main/pi-checkpoint';

const execFileAsync = promisify(execFile);

const TARGET = 'qa/manual-checklist.md';

async function sha256(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function gitStatus(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['status', '--porcelain'], { cwd, windowsHide: true });
  return stdout.trim();
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
  const cwd = process.cwd();
  const { apiKey, model } = await loadPetConfig();
  const systemPrompt = JSON.parse(await readFile(path.join(cwd, 'role-card.json'), 'utf8'))
    .systemPrompt as string;
  const workspace = describeWorkspace();

  console.log('========================================');
  console.log(`工作目录    : ${workspace.dir}`);
  console.log(`开放工具    : ${workspace.tools.join(', ')}`);
  console.log(`练习靶子    : ${TARGET}`);
  console.log('========================================');

  // ---- 0) 受保护路径的拦截函数（不用花钱的纯函数检查）----
  console.log('\n--- 测试 0：受保护路径判定 ---');
  for (const candidate of ['.env', 'src/.env.local', '.git/config', 'node_modules/x.js', 'package-lock.json', '.pet-builder.json', 'src/main/pi-engine.ts']) {
    const hit = isProtectedPath(candidate);
    console.log(`  ${candidate.padEnd(28)} → ${hit === undefined ? '允许' : `拦截（命中 ${hit}）`}`);
  }

  // ---- 1) 改之前：记下靶子的指纹 ----
  const before = await sha256(path.join(cwd, TARGET));
  console.log(`\n--- 测试 1：让肆改靶子文件 ---`);
  console.log(`改前 sha256: ${before.slice(0, 16)}...`);

  const toolNames: string[] = [];
  await piChatStream({
    apiKey,
    model,
    systemPrompt,
    text: `用你的 edit 工具，在 ${TARGET} 文件末尾追加一行内容：<!-- pi checkpoint probe -->，然后用一句话确认你改完了。`,
    history: [],
    onDelta: (delta) => process.stdout.write(delta),
    onEvent: (event) => {
      if (event.type === 'tool_execution_start') {
        toolNames.push(event.toolName ?? '未知');
        console.log(`\n[工具调用] ${event.toolName}`);
      }
    },
  });
  console.log(`\n[工具调用记录: ${toolNames.join(', ') || '没有调工具'}]`);

  // ---- 2) 改之后：文件变了没？存档写了没？----
  const after = await sha256(path.join(cwd, TARGET));
  console.log(`\n--- 测试 2：改动与存档记录 ---`);
  console.log(`改后 sha256: ${after.slice(0, 16)}...  → ${after === before ? '❌ 文件没变' : '✅ 文件确实被改了'}`);
  const record = readLatestCheckpoint(cwd);
  console.log(`存档记录: ${record ? `✅ ${record.ref.slice(0, 10)} (${record.reason})` : '❌ 没有任何存档'}`);

  // ---- 3) 撤回：文件回来了没？----
  console.log(`\n--- 测试 3：撤回 ---`);
  const restored = await restoreLatestCheckpoint(cwd);
  console.log(`撤回目标: ${restored ? restored.ref.slice(0, 10) : '（无记录）'}`);
  // 注意：不能用字节级 sha256 判断是否还原 —— git reset --hard 会按 core.autocrlf
  // 规则重新落盘，换行符（CRLF/LF）可能变化，字节不同但 git 认为内容一致。
  // 真正的语义判断是 git 自己怎么看：工作区应该是干净的。
  const status = await gitStatus(cwd);
  console.log(`撤回后 git status: ${status.length === 0 ? '（空 = 干净）' : status}`);
  console.log(status.length === 0 ? '✅ 工作区已回到存档那一刻' : '❌ 工作区还有差异（需要人工看一眼）');
  const reverted = await sha256(path.join(cwd, TARGET));
  console.log(`参考：改前 ${before.slice(0, 16)} / 撤回后 ${reverted.slice(0, 16)}（换行符差异属正常）`);

  await resetPiChatSession();
  console.log('\n=== 探针结束 ===');
}

void main().catch((error) => {
  console.error('\n[探针失败]');
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exitCode = 1;
});
