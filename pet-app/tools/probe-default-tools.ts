/**
 * probe-default-tools.ts —— 验「装完就能改文件」（默认能力层）+ 安全语义一条没松。
 * 零网络、零 API 成本、完全隔离。
 *
 * 背景：以前默认生效的是第 1 层「只读」，要改文件必须自己设 PET_PI_TOOLS=read,edit。
 * 打包版的工作区 <petRoot>\workspace 装完是**空的**，只读等于"装完只能看"。
 * 这一版把基础层改成 read + edit + write（pi 的 edit 只改已存在的文件，新建文件靠 write）。
 *
 * 它断言的是（全部离线）：
 *   ① 默认（不设 PET_PI_TOOLS）→ 生效工具里有 edit 和 write
 *   ② PET_PI_TOOLS 仍然是**加法**（叠加），不是替换；重复项不重复
 *   ③ 硬门（.env / .git/ / node_modules/ / package-lock.json / .pet-builder.json）
 *      仍然永远拒绝 —— 判定函数 + checkpoint 扩展的 tool_call 处理器两层都验
 *   ④ 授权门语义不变：工作区外 → ask（弹窗），工作区内 → allow，只读工具不受影响
 *   ⑤ 互动气泡（piShortReply）仍然**一个工具都不给**
 *   ⑥ 工具全关那条安全网还在（allowTools=false → 空列表）
 *   ⑦ 全程没碰真实的 %APPDATA%\肆（跑完核对指纹）
 *
 * 隔离手段：PET_PI_ROOT / APPDATA / PET_PI_WORKSPACE 全部指向临时目录，
 * 并且开跑前断言"它真的在临时目录里"（不满足就直接退出 1）。
 *
 * 运行：
 *   cd F:\ss_yong\si\pet-si\pet-app
 *   npx tsx tools/probe-default-tools.ts
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { describeShortReplyTools, describeWorkspace } from '../src/main/pi-engine';
import { createApprovalExtension, decideApproval, hardGateHit } from '../src/main/pi-approval';
import { createCheckpointExtension, isProtectedPath } from '../src/main/pi-checkpoint';
import type { ApprovalDecision } from '../src/shared/contracts';

// 真实数据目录（在改 APPDATA 之前记下来）—— 跑完必须逐字节一致
const REAL_PET_ROOT = path.join(
  process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'),
  '肆',
);

const sandbox = path.join(os.tmpdir(), `si-default-tools-${Date.now()}-${process.pid}`);

let failures = 0;
let passed = 0;

/** 一条断言。失败时打印可读原因（而不是只抛一个栈） */
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1;
    console.log(`  ✅ ${label}${detail ? `  —— ${detail}` : ''}`);
    return;
  }
  failures += 1;
  console.log(`  ❌ ${label}${detail ? `  —— ${detail}` : ''}`);
}

/** 文件指纹：用来证明真实的存档/自述文件没被动过 */
function signatureOf(file: string): string {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
  } catch {
    return '(不存在)';
  }
}

/** 一组工具名是否都在列表里 */
function hasAll(tools: readonly string[], names: readonly string[]): boolean {
  return names.every((name) => tools.includes(name));
}

/** 假 pi：只收 tool_call 处理器，用来走一遍真实扩展的接线（不叫模型） */
interface FakeToolCall {
  type: 'tool_call';
  toolName: string;
  toolCallId: string;
  input: Record<string, unknown>;
}
type ToolCallHandler = (event: FakeToolCall) => Promise<{ block?: boolean; reason?: string } | undefined>;

function captureToolCallHandler(install: (pi: unknown) => void): ToolCallHandler {
  let handler: ToolCallHandler | undefined;
  const fakePi = {
    on: (name: string, value: ToolCallHandler) => {
      if (name === 'tool_call') handler = value;
      return () => { };
    },
  };
  install(fakePi);
  if (!handler) throw new Error('假 pi 没收到 tool_call 处理器');
  return handler;
}

async function main(): Promise<void> {
  // ── 0) 隔离 + 红线自检 ──────────────────────────────────────────────────
  const realCheckpoints = signatureOf(path.join(REAL_PET_ROOT, 'pi-checkpoints.json'));
  const realWorkspaceReadme = signatureOf(path.join(REAL_PET_ROOT, 'workspace', 'README.txt'));

  mkdirSync(sandbox, { recursive: true });
  const petRoot = path.join(sandbox, 'pet-root');
  const appData = path.join(sandbox, 'appdata');
  const workspaceTree = path.join(sandbox, 'src-tree');   // 合格源码目录（有 src/main.ts）
  const neutralCwd = path.join(sandbox, 'neutral-cwd');   // cwd 挪走，别误用探针自己的项目目录
  for (const dir of [petRoot, appData, workspaceTree, neutralCwd]) mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(workspaceTree, 'package.json'), '{"name":"probe"}\n', 'utf8');
  mkdirSync(path.join(workspaceTree, 'src'), { recursive: true });
  writeFileSync(path.join(workspaceTree, 'src', 'main.ts'), '// probe\n', 'utf8');

  process.env.PET_PI_ROOT = petRoot;
  process.env.APPDATA = appData;
  process.env.PET_PI_WORKSPACE = workspaceTree;
  delete process.env.PET_PI_TOOLS;
  const startedCwd = process.cwd();
  process.chdir(neutralCwd);

  console.log('========================================');
  console.log('默认能力层探针（零 API 成本）');
  console.log(`临时工作目录: ${workspaceTree}`);
  console.log(`临时数据目录: ${petRoot}`);
  console.log(`真实数据目录: ${REAL_PET_ROOT}（只读，跑完核对指纹）`);
  console.log('========================================');

  // 红线：describeWorkspace() 会顺手建兜底目录，绝不能让它在真实目录里发生
  const resolved = describeWorkspace();
  const rel = (target: string): string => path.relative(os.tmpdir(), target);
  const insideTmp = (target: string): boolean => {
    const r = rel(target);
    return r.length > 0 && !r.startsWith('..') && !path.isAbsolute(r);
  };
  if (!insideTmp(resolved.dir) || !insideTmp(petRoot)) {
    throw new Error(`探针拒绝运行：工作目录跑到临时目录外面去了（${resolved.dir}）`);
  }

  // ── 1) 默认层：能读也能改 ───────────────────────────────────────────────
  console.log('\n--- ① 默认（不设 PET_PI_TOOLS）---');
  const fallbackDir = path.join(petRoot, 'workspace');
  delete process.env.PET_PI_WORKSPACE;   // 最接近打包版：cwd 不是源码树 → 走兜底工作区
  const byDefault = describeWorkspace();
  console.log(`  生效工具: ${byDefault.tools.join(', ')}`);
  check('默认扫到兜底工作区 <petRoot>\\workspace', path.resolve(byDefault.dir) === path.resolve(fallbackDir),
    `期望 ${fallbackDir}，实际 ${byDefault.dir}`);
  check('默认层是 readEdit', byDefault.defaultTier === 'readEdit', `实际 ${byDefault.defaultTier}`);
  check('默认工具里有 edit（改已有文件）', byDefault.tools.includes('edit'), JSON.stringify(byDefault.tools));
  check('默认工具里有 write（新建文件）', byDefault.tools.includes('write'), JSON.stringify(byDefault.tools));
  check('默认工具里读那一套还在', hasAll(byDefault.tools, ['read', 'grep', 'find', 'ls']));
  check('默认工具里自定义工具没被挤掉（白名单管所有工具）',
    hasAll(byDefault.tools, ['run_checks', 'git_status', 'say', 'play_animation', 'remind', 'create_skill', 'list_skills']),
    JSON.stringify(byDefault.tools));
  check('默认工具里没有 bash（第 3 层没开）', !byDefault.tools.includes('bash'), JSON.stringify(byDefault.tools));

  // ── 2) PET_PI_TOOLS 仍然是加法，不是替换 ────────────────────────────────
  console.log('\n--- ② PET_PI_TOOLS 是叠加 ---');
  process.env.PET_PI_TOOLS = 'bash';
  const withExtra = describeWorkspace();
  check('额外指定的 bash 进来了', withExtra.tools.includes('bash'), JSON.stringify(withExtra.tools));
  check('叠加之后 edit / write 仍在（没被环境变量顶掉）',
    hasAll(withExtra.tools, ['edit', 'write', 'read', 'run_checks', 'git_status']), JSON.stringify(withExtra.tools));
  check('叠加 = 基础层 + 额外项，不多不少',
    withExtra.tools.length === byDefault.tools.length + 1, `${withExtra.tools.length} vs ${byDefault.tools.length + 1}`);

  process.env.PET_PI_TOOLS = ' bash , edit , write ';
  const messy = describeWorkspace();
  check('带空格 / 重复项 / 已在基础层里的名字都不会重复',
    messy.tools.length === byDefault.tools.length + 1 && messy.tools.includes('bash'), JSON.stringify(messy.tools));
  process.env.PET_PI_TOOLS = '   ,  ';
  const blank = describeWorkspace();
  check('只有空白/逗号的环境变量等于没设', blank.tools.length === byDefault.tools.length, JSON.stringify(blank.tools));
  delete process.env.PET_PI_TOOLS;

  // ── 3) 硬门：永远拒绝，授权也解不开 ────────────────────────────────────
  console.log('\n--- ③ 硬门（判定函数）---');
  const cwd = byDefault.dir;
  for (const target of ['.env', 'config/.env.local', '.git/config', 'node_modules/x.js', 'package-lock.json', '.pet-builder.json']) {
    const hit = isProtectedPath(target);
    check(`isProtectedPath 认出 ${target}`, hit !== undefined, `实际 ${hit ?? 'undefined'}`);
    const verdict = decideApproval({ cwd, target, allowedDirs: [], toolName: 'edit' });
    check(`决定是 deny-hard：${target}`, verdict === 'deny-hard', `实际 ${verdict}`);
  }
  check('正常文件不撞硬门', isProtectedPath(path.join(cwd, 'src', 'notes.md')) === undefined);
  check('hardGateHit 认得反斜杠形式', hardGateHit(path.join(cwd, 'node_modules', 'a.js')) === 'node_modules/');
  const outsideFile = path.join(os.tmpdir(), '别人的桌面', '报告.docx');
  check('授权了也解不开硬门', decideApproval({ cwd, target: path.join(cwd, '.env'), allowedDirs: [cwd], toolName: 'write' }) === 'deny-hard');
  check('工作区外的 .env 同样是 deny-hard', decideApproval({ cwd, target: path.join(outsideFile, '..', '.env'), allowedDirs: [], toolName: 'edit' }) === 'deny-hard');

  console.log('\n--- ③-b 硬门（checkpoint 扩展的 tool_call 真接线）---');
  const checkpointHandler = captureToolCallHandler((pi) => {
    createCheckpointExtension({ cwd })(pi as Parameters<ReturnType<typeof createCheckpointExtension>>[0]);
  });
  const callCheckpoint = (toolName: string, target: string): Promise<{ block?: boolean; reason?: string } | undefined> =>
    checkpointHandler({ type: 'tool_call', toolName, toolCallId: 'probe', input: { path: target } });

  const envBlocked = await callCheckpoint('edit', '.env');
  check('edit .env → 被拦（block=true）', envBlocked?.block === true, JSON.stringify(envBlocked));
  check('拦截理由说的是受保护路径', envBlocked?.reason?.includes('受保护路径') === true, envBlocked?.reason ?? '(undefined)');
  const writeEnvBlocked = await callCheckpoint('write', '.env.local');
  check('write .env.local → 也被拦', writeEnvBlocked?.block === true, JSON.stringify(writeEnvBlocked));
  const lockBlocked = await callCheckpoint('write', 'package-lock.json');
  check('write package-lock.json → 也被拦', lockBlocked?.block === true, JSON.stringify(lockBlocked));

  const normalFile = path.join(cwd, 'notes.md');
  writeFileSync(normalFile, '旧内容\n', 'utf8');
  const normalResult = await callCheckpoint('write', 'notes.md');
  check('普通文件不拦（放行 + 顺手存档）', normalResult === undefined, JSON.stringify(normalResult));
  const backupRoot = path.join(petRoot, 'pi-backups');
  const backups = existsSync(backupRoot) ? readdirSync(backupRoot, { recursive: true }) : [];
  check('放行的文件真被存了副本（存档层照旧）', backups.some((entry) => String(entry).endsWith('notes.md')),
    `副本目录 ${backupRoot} 下的条目：${backups.map(String).join(' | ') || '(空)'}`);
  check('只读工具完全不进这道门', (await callCheckpoint('read', 'notes.md')) === undefined);

  // ── 4) 授权门语义不变 ──────────────────────────────────────────────────
  console.log('\n--- ④ 授权门（工作区内外）---');
  check('工作区内的文件 → allow（不打扰主人）',
    decideApproval({ cwd, target: path.join(cwd, 'notes.md'), allowedDirs: [], toolName: 'edit' }) === 'allow');
  check('工作区外 → ask（弹窗问主人）',
    decideApproval({ cwd, target: outsideFile, allowedDirs: [], toolName: 'edit' }) === 'ask');
  check('工作区外 + 未授权 + write → ask',
    decideApproval({ cwd, target: outsideFile, allowedDirs: [], toolName: 'write' }) === 'ask');
  check('工作区外 + 已授权目录 → allow',
    decideApproval({ cwd, target: path.join(os.tmpdir(), '别人的桌面', 'a.txt'), allowedDirs: [path.join(os.tmpdir(), '别人的桌面')], toolName: 'edit' }) === 'allow');
  check('只读工具不受这道门影响',
    decideApproval({ cwd, target: outsideFile, allowedDirs: [], toolName: 'read' }) === 'allow');

  console.log('\n--- ④-b 授权门扩展的 tool_call 真接线（拒绝 / 仅这次 / 这个目录）---');
  let requesterCalls = 0;
  let decision: ApprovalDecision = 'deny';
  const fakeRequester = async (): Promise<ApprovalDecision> => {
    requesterCalls += 1;
    return decision;
  };
  const approvalHandler = captureToolCallHandler((pi) => {
    createApprovalExtension({ cwd, getRequester: () => fakeRequester })(
      pi as Parameters<ReturnType<typeof createApprovalExtension>>[0],
    );
  });
  const callApproval = (toolName: string, target: string): Promise<{ block?: boolean; reason?: string } | undefined> =>
    approvalHandler({ type: 'tool_call', toolName, toolCallId: 'probe', input: { path: target } });

  requesterCalls = 0;
  decision = 'deny';
  const denied = await callApproval('write', outsideFile);
  check('工作区外 + 主人拒绝 → 拦下', denied?.block === true, JSON.stringify(denied));
  check('工作区外确实问了主人一次', requesterCalls === 1, `问 ${requesterCalls} 次`);
  decision = 'once';
  const once = await callApproval('write', outsideFile);
  check('工作区外 + 「仅这次」→ 放行', once === undefined, JSON.stringify(once));
  requesterCalls = 0;
  const inside = await callApproval('write', path.join(cwd, 'notes.md'));
  check('工作区内 → 一次都不问', inside === undefined && requesterCalls === 0, `问 ${requesterCalls} 次`);

  // ── 5) 互动气泡永远不给工具 ────────────────────────────────────────────
  console.log('\n--- ⑤ 互动气泡（piShortReply）---');
  const shortReplyTools = describeShortReplyTools();
  check('气泡那条路径开放的工具是空列表', shortReplyTools.length === 0, JSON.stringify(shortReplyTools));
  check('气泡不给 edit / write', !shortReplyTools.includes('edit') && !shortReplyTools.includes('write'));

  // ── 6) 工具全关的安全网还在 ────────────────────────────────────────────
  console.log('\n--- ⑥ 安全网（兜底目录建不出来）---');
  const blockedRoot = path.join(sandbox, 'pet-root-blocked');
  writeFileSync(blockedRoot, 'not a directory\n', 'utf8');
  process.env.PET_PI_ROOT = blockedRoot;
  const blocked = describeWorkspace();
  check('petRoot 被文件占住 → allowTools = false', blocked.allowTools === false, `实际 ${blocked.allowTools}`);
  check('退回"只能说话"：工具列表为空（edit / write 也不给）', blocked.tools.length === 0, JSON.stringify(blocked.tools));
  process.env.PET_PI_ROOT = petRoot;

  // ── 7) 隔离核对 + 收尾 ────────────────────────────────────────────────
  console.log('\n--- ⑦ 隔离核对 ---');
  check('真实 %APPDATA%\\肆\\pi-checkpoints.json 一个字节都没变',
    signatureOf(path.join(REAL_PET_ROOT, 'pi-checkpoints.json')) === realCheckpoints);
  check('真实 %APPDATA%\\肆\\workspace\\README.txt 一个字节都没变',
    signatureOf(path.join(REAL_PET_ROOT, 'workspace', 'README.txt')) === realWorkspaceReadme);
  check('临时兜底目录是探针建的，不在真实目录里',
    path.resolve(fallbackDir) !== path.resolve(path.join(REAL_PET_ROOT, 'workspace')) && insideTmp(fallbackDir),
    fallbackDir);

  process.chdir(startedCwd);
  delete process.env.PET_PI_ROOT;
  delete process.env.PET_PI_WORKSPACE;
  delete process.env.PET_PI_TOOLS;
  rmSync(sandbox, { recursive: true, force: true });
  console.log(`\n（已清理临时目录 ${sandbox}）`);

  console.log('\n========================================');
  if (failures === 0) {
    console.log(`默认能力层探针：全部通过（${passed} 项）✅`);
    console.log('========================================');
    return;
  }
  console.log(`默认能力层探针：${failures} 项失败 / 共 ${passed + failures} 项 ❌`);
  console.log('========================================');
  process.exitCode = 1;
}

void main().catch((error) => {
  console.error('\n[探针失败]');
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  rmSync(sandbox, { recursive: true, force: true });
  process.exitCode = 1;
});
