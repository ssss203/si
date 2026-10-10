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
 * 撤回的语义（修掉 add -A / reset --hard 之后）：
 *   · 快照只提交这一回合的目标路径（`git commit -- <paths>`，不再 `git add -A`）
 *   · 撤回只还原那些路径（`git checkout <ref> -- <paths>`，不再 `git reset --hard`）
 *   所以这里除了"靶子回来了没"，还要断言"靶子以外的工作区一行都没被动过"。
 *   注意：它会在真实仓库里产生一个 checkpoint(肆) 提交（老行为也是），跑完把靶子的改动撤掉。
 * 零 API 成本的同类探针见 tools/probe-checkpoint-scope.ts（临时仓库 + 隔离存档）。
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

async function gitStatus(cwd: string, extra: string[] = []): Promise<string> {
  const { stdout } = await execFileAsync('git', ['status', '--porcelain', ...extra], { cwd, windowsHide: true });
  return stdout.replace(/\r\n/g, '\n').trim();
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

  // ---- 1) 改之前：记下靶子的指纹 + 工作区里"别人的改动" ----
  const before = await sha256(path.join(cwd, TARGET));
  // 撤回只许动靶子，所以先记下靶子以外的工作区状态，撤回后再比一次（下面测试 3 的断言）
  const statusBefore = await gitStatus(cwd);
  console.log(`\n--- 测试 1：让肆改靶子文件 ---`);
  console.log(`改前 sha256: ${before.slice(0, 16)}...`);
  console.log(`改前工作区:\n${statusBefore.length === 0 ? '（空 = 干净）' : statusBefore}`);

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
  console.log(`存档记录: ${record ? `✅ ${record.ref ? record.ref.slice(0, 10) : '（没有 git 快照，只有文件副本）'} (${record.reason})` : '❌ 没有任何存档'}`);

  // ---- 3) 撤回：靶子回来了没？别人的改动有没有被顺手抹掉？----
  console.log(`\n--- 测试 3：撤回 ---`);
  const restored = await restoreLatestCheckpoint(cwd);
  console.log(`撤回目标: ${restored ? (restored.ref ? restored.ref.slice(0, 10) : '（无 ref，只走文件副本）') : '（无记录）'}`);
  // 判断"靶子回来了没"有两个口径：
  //   1. 字节级 sha256 —— 撤回走 `git checkout <ref> -- <path>`，同样会按 core.autocrlf
  //      规则重新落盘，换行符（CRLF/LF）可能变化，字节不同但 git 认为内容一致；
  //   2. git 自己怎么看这个文件：`git status --porcelain -- <靶子>` 为空 = 它和快照一致。
  const targetDirty = (await gitStatus(cwd, ['--', TARGET])).length > 0;
  const reverted = await sha256(path.join(cwd, TARGET));
  console.log(`撤回后靶子 sha256: ${reverted.slice(0, 16)}...`);
  console.log(reverted === before || !targetDirty
    ? '✅ 靶子已回到存档那一刻'
    : '❌ 靶子没还原（需要人工看一眼）');

  // 新语义（`git checkout <ref> -- <paths>`，不再是 `git reset --hard`）的关键断言：
  // 撤回**只**还原它动过的那几个文件，靶子以外的东西一行都不许碰。
  const statusAfter = await gitStatus(cwd);
  const others = (text: string): string[] =>
    text.split('\n').map((line) => line.trim()).filter((line) => line.length > 0 && !line.includes(TARGET));
  const othersBefore = others(statusBefore);
  const othersAfter = others(statusAfter);
  console.log(othersBefore.join('|') === othersAfter.join('|')
    ? '✅ 靶子以外的文件（用户其它未提交改动）一个都没被碰'
    : `❌ 靶子以外的东西变了：\n  撤回前: ${othersBefore.join(' / ') || '（无）'}\n  撤回后: ${othersAfter.join(' / ') || '（无）'}`);
  console.log(`（参考）撤回后完整 git status:\n${statusAfter.length === 0 ? '（空 = 干净）' : statusAfter}`);

  await resetPiChatSession();
  console.log('\n=== 探针结束 ===');
}

void main().catch((error) => {
  console.error('\n[探针失败]');
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exitCode = 1;
});
