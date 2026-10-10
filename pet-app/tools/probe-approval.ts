/**
 * probe-approval.ts —— 授权门（阶段 F）的**零 API 成本**探针。
 *
 * 它不连模型、不改项目文件，只验两件事：
 *   1. 判定逻辑 decideApproval()：工作目录内 → allow；目录已授权 → allow；
 *      工作目录外且没授权 → ask；硬门（.env / .git/ / node_modules/ /
 *      package-lock.json / .pet-builder.json）→ deny-hard（授权也不解锁）。
 *   2. 已授权目录的读写：新增 / 去重 / 撤销（含子目录）/ 坏文件容错 / 入参校验。
 *
 * ⚠️ 安全红线：**绝不碰真实的 %APPDATA%\肆**。
 *   探针自己把 PET_PI_ALLOWED_DIRS 指到系统临时目录下的一个文件，
 *   并且在开跑前断言那个路径确实在 tmpdir 里（不满足就直接退出 1）。
 *
 * 运行（在项目根目录）：
 *   npx tsx tools/probe-approval.ts
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import {
  DEFAULT_APPROVAL_TIMEOUT_MS,
  addAllowedDir,
  allowedDirsFile,
  approvalTimeoutMs,
  assertAllowedDir,
  createApprovalExtension,
  decideApproval,
  hardGateHit,
  isDirAllowed,
  readAllowedDirs,
  removeAllowedDir,
  writeAllowedDirs,
} from '../src/main/pi-approval';
import type { ApprovalDecision } from '../src/shared/contracts';

let passed = 0;
const failures: string[] = [];

/** 记一条断言结果 */
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed += 1;
    console.log(`  ✅ ${name}${detail ? `  —— ${detail}` : ''}`);
  } else {
    failures.push(name);
    console.log(`  ❌ ${name}${detail ? `  —— ${detail}` : ''}`);
  }
}

/** 判定结果对比 */
function expectVerdict(label: string, actual: string, expected: string): void {
  check(label, actual === expected, `期望 ${expected}，实际 ${actual}`);
}

function expectThrows(label: string, action: () => unknown): void {
  try {
    action();
    check(label, false, '本该抛错，却通过了');
  } catch (error) {
    check(label, true, error instanceof Error ? error.message : String(error));
  }
}

async function main(): Promise<void> {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'pet-approval-probe-'));
  const storeFile = path.join(tmp, 'state', 'allowed-dirs.json');
  process.env.PET_PI_ALLOWED_DIRS = storeFile;

  // 红线：确认探针写的不是主人真实的 %APPDATA%\肆
  const resolvedStore = allowedDirsFile();
  const insideTmp = path.relative(os.tmpdir(), resolvedStore);
  if (insideTmp.startsWith('..') || path.isAbsolute(insideTmp)) {
    throw new Error(`探针拒绝运行：授权文件跑到临时目录外面去了（${resolvedStore}）`);
  }

  const cwd = path.join(tmp, 'proj');
  const outside = path.join(tmp, 'outside');          // 会被授权的"项目外目录"
  const stranger = path.join(tmp, 'stranger');        // 一直不授权的"项目外目录"
  const sibling = path.join(tmp, 'proj-sibling');     // 名字只差一个后缀的邻居目录

  console.log('========================================');
  console.log('授权门探针（零 API 成本）');
  console.log(`临时授权文件: ${resolvedStore}`);
  console.log(`假装的工作目录: ${cwd}`);
  console.log('========================================');

  // ── 1) 判定逻辑 ──────────────────────────────────────────────────────────
  console.log('\n--- 1) decideApproval：工作目录内外 ---');
  const noDirs: string[] = [];
  expectVerdict('工作目录内的相对路径 → allow', decideApproval({ cwd, target: 'src/main.ts', allowedDirs: noDirs, toolName: 'edit' }), 'allow');
  expectVerdict('工作目录内的深层路径 → allow', decideApproval({ cwd, target: 'a/b/c/d.txt', allowedDirs: noDirs, toolName: 'write' }), 'allow');
  expectVerdict('带 .. 但没跑出工作目录 → allow', decideApproval({ cwd, target: 'src/../src/x.ts', allowedDirs: noDirs, toolName: 'edit' }), 'allow');
  expectVerdict('工作目录本身 → allow', decideApproval({ cwd, target: '.', allowedDirs: noDirs }), 'allow');
  expectVerdict('空路径 → allow（没有目标可管）', decideApproval({ cwd, target: '', allowedDirs: noDirs }), 'allow');
  expectVerdict('只读工具（read）→ allow', decideApproval({ cwd, target: stranger, allowedDirs: noDirs, toolName: 'read' }), 'allow');
  expectVerdict('工作目录外的绝对路径 → ask', decideApproval({ cwd, target: path.join(stranger, 'a.txt'), allowedDirs: noDirs, toolName: 'edit' }), 'ask');
  expectVerdict('用 ../ 跑出工作目录 → ask', decideApproval({ cwd, target: '../stranger/a.txt', allowedDirs: noDirs, toolName: 'write' }), 'ask');
  expectVerdict('名字只差后缀的邻居目录 → ask（不能被前缀骗了）', decideApproval({ cwd, target: path.join(sibling, 'a.txt'), allowedDirs: noDirs, toolName: 'edit' }), 'ask');

  console.log('\n--- 2) decideApproval：已授权目录 ---');
  expectVerdict('授权目录里的文件 → allow', decideApproval({ cwd, target: path.join(outside, 'a.txt'), allowedDirs: [outside], toolName: 'edit' }), 'allow');
  expectVerdict('授权目录的子目录 → allow（授权是整棵子树）', decideApproval({ cwd, target: path.join(outside, 'deep', 'b.txt'), allowedDirs: [outside], toolName: 'write' }), 'allow');
  expectVerdict('授权目录的路径前缀邻居 → ask', decideApproval({ cwd, target: `${outside}-x/c.txt`, allowedDirs: [outside], toolName: 'edit' }), 'ask');
  expectVerdict('没授权到的目录 → ask', decideApproval({ cwd, target: path.join(stranger, 'a.txt'), allowedDirs: [outside], toolName: 'edit' }), 'ask');
  check('isDirAllowed：目录本身算已授权', isDirAllowed(outside, [outside]));
  check('isDirAllowed：子目录算已授权', isDirAllowed(path.join(outside, 'deep'), [outside]));
  check('isDirAllowed：前缀邻居不算', !isDirAllowed(`${outside}-x`, [outside]));

  console.log('\n--- 3) 硬门（永不弹窗、直接拒绝）---');
  for (const target of ['.env', 'config/.env.local', 'node_modules/x.js', 'package-lock.json', '.pet-builder.json', '.git/config']) {
    expectVerdict(`硬门 ${target} → deny-hard`, decideApproval({ cwd, target, allowedDirs: noDirs, toolName: 'edit' }), 'deny-hard');
  }
  expectVerdict(
    '硬门的绝对路径（反斜杠）→ deny-hard',
    decideApproval({ cwd, target: path.join(cwd, 'node_modules', 'foo', 'index.js'), allowedDirs: noDirs, toolName: 'write' }),
    'deny-hard',
  );
  expectVerdict(
    '工作目录外的 .env → deny-hard',
    decideApproval({ cwd, target: path.join(stranger, '.env'), allowedDirs: noDirs, toolName: 'edit' }),
    'deny-hard',
  );
  expectVerdict(
    '已授权目录里的 .env → 仍然 deny-hard（授权不能解锁硬门）',
    decideApproval({ cwd, target: path.join(outside, '.env'), allowedDirs: [outside], toolName: 'edit' }),
    'deny-hard',
  );
  expectVerdict(
    '已授权目录里的 node_modules → 仍然 deny-hard',
    decideApproval({ cwd, target: path.join(outside, 'node_modules', 'x.js'), allowedDirs: [outside], toolName: 'write' }),
    'deny-hard',
  );
  check('hardGateHit 能认出反斜杠形式的 node_modules', hardGateHit(path.join(tmp, 'node_modules', 'a.js')) === 'node_modules/');
  check('hardGateHit 对正常文件返回 undefined', hardGateHit(path.join(tmp, 'src', 'main.ts')) === undefined);

  // ── 2) 已授权目录的读写 ──────────────────────────────────────────────────
  console.log('\n--- 4) allowed-dirs.json 的读写（临时目录）---');
  check('一开始没有任何授权', readAllowedDirs().length === 0);
  check('文件还不存在', !existsSync(resolvedStore));

  const afterFirst = addAllowedDir(outside);
  check('新增一个授权目录', afterFirst.length === 1 && afterFirst[0] === path.resolve(outside), afterFirst.join(' | '));
  check('文件写出来了', existsSync(resolvedStore));
  const rawAfterFirst = JSON.parse(readFileSync(resolvedStore, 'utf8')) as unknown;
  check('落盘格式是 JSON 数组', Array.isArray(rawAfterFirst) && rawAfterFirst.length === 1);

  const afterDuplicate = addAllowedDir(outside);
  check('重复新增会去重', afterDuplicate.length === 1, `长度 ${afterDuplicate.length}`);

  const afterSlash = addAllowedDir(`${outside}${path.sep}`);
  check('带尾部分隔符的写法也去重', afterSlash.length === 1, `长度 ${afterSlash.length}`);

  const afterCase = addAllowedDir(process.platform === 'win32' ? outside.toUpperCase() : outside);
  check('同一目录的大小写变体也去重', afterCase.length === 1, `长度 ${afterCase.length}`);

  addAllowedDir(stranger);
  check('再加一个就变成两条', readAllowedDirs().length === 2);
  check('readAllowedDirs 读回来的是规范化绝对路径', readAllowedDirs().every((item) => path.isAbsolute(item)));

  const afterRemove = removeAllowedDir(stranger);
  check('撤销一条之后只剩另一条', afterRemove.length === 1 && afterRemove[0] === path.resolve(outside), afterRemove.join(' | '));

  const parent = path.join(tmp, 'tree');
  const child = path.join(parent, 'child');
  const grandChild = path.join(child, 'grand');
  writeAllowedDirs([]);   // 先清空，只看这三条
  addAllowedDir(parent);
  addAllowedDir(child);
  addAllowedDir(grandChild);
  check('父 + 子 + 孙三条都在', readAllowedDirs().length === 3, readAllowedDirs().join(' | '));
  const afterParentRemove = removeAllowedDir(parent);
  check('撤销父目录会连带撤掉它下面的条目', afterParentRemove.length === 0, afterParentRemove.join(' | '));

  writeAllowedDirs([outside, outside, 'relative/bad', 123, '']);
  check('writeAllowedDirs 丢掉相对路径和非字符串', readAllowedDirs().length === 1 && readAllowedDirs()[0] === path.resolve(outside));

  writeFileSync(resolvedStore, '{ this is not json', 'utf8');
  check('坏 JSON 当"一个都没授权"', readAllowedDirs().length === 0);
  writeFileSync(resolvedStore, '{"dirs":[]}', 'utf8');
  check('不是数组也当"一个都没授权"', readAllowedDirs().length === 0);
  rmSync(path.dirname(resolvedStore), { recursive: true, force: true });

  console.log('\n--- 5) 入参校验（IPC 也会走这里）---');
  expectThrows('相对路径被拒', () => assertAllowedDir('relative/dir'));
  expectThrows('空字符串被拒', () => assertAllowedDir('   '));
  expectThrows('非字符串被拒', () => assertAllowedDir(42));
  expectThrows('超长路径被拒', () => assertAllowedDir(path.join(tmp, 'x'.repeat(400))));
  expectThrows('磁盘根被拒', () => assertAllowedDir(path.parse(tmp).root));
  expectThrows('含空字符的路径被拒', () => assertAllowedDir(`${tmp}\u0000evil`));
  check('正常绝对路径通过并规范化', assertAllowedDir(path.join(outside, '.', 'deep', '..')) === path.resolve(outside));

  console.log('\n--- 6) 超时常量 ---');
  check('默认自动拒绝超时是 60 秒', DEFAULT_APPROVAL_TIMEOUT_MS === 60_000, `${DEFAULT_APPROVAL_TIMEOUT_MS} ms`);
  check('没有环境变量时 approvalTimeoutMs() 也是 60 秒', approvalTimeoutMs() === 60_000, `${approvalTimeoutMs()} ms`);

  // ── 3) 真的把扩展挂上去，走一遍 tool_call 处理器 ────────────────────────
  // 这里不用模型：自己造一个假 pi（只收 tool_call 处理器）和一个假"主人"。
  // 它验的是接线本身 —— 拦截理由怎么写、选"这个目录以后都允许"有没有落盘、
  // 超时到底会不会变成拒绝。全部零成本。
  console.log('\n--- 7) 授权门扩展的 tool_call 处理器 ---');

  interface FakeEvent {
    type: 'tool_call';
    toolName: string;
    toolCallId: string;
    input: Record<string, unknown>;
  }
  type Handler = (event: FakeEvent) => Promise<{ block?: boolean; reason?: string } | undefined>;

  let handler: Handler | undefined;
  const fakePi = {
    on: (name: string, value: Handler) => {
      if (name === 'tool_call') handler = value;
      return () => { };
    },
  };
  let requesterCalls = 0;
  let requester: ((request: { toolName: string; path: string; dir: string; signal?: AbortSignal }) => Promise<ApprovalDecision>) | undefined;
  const extension = createApprovalExtension({ cwd, getRequester: () => requester });
  extension(fakePi as unknown as Parameters<typeof extension>[0]);
  if (!handler) throw new Error('假 pi 没收到 tool_call 处理器');

  const call = async (toolName: string, target: string): Promise<{ block?: boolean; reason?: string } | undefined> =>
    handler!({ type: 'tool_call', toolName, toolCallId: 'probe', input: { path: target } });

  writeAllowedDirs([]);
  requesterCalls = 0;
  requester = undefined;
  const insideResult = await call('edit', 'src/main.ts');
  check('工作目录内：不打扰主人，放行', insideResult === undefined && requesterCalls === 0);

  const readResult = await call('read', path.join(stranger, 'a.txt'));
  check('只读工具：这道门不管，放行', readResult === undefined && requesterCalls === 0);

  const hardResult = await call('edit', '.env');
  check('硬门：直接拒绝，且没有弹窗', hardResult?.block === true && hardResult.reason?.includes('硬门不能用授权解锁') === true);
  check('硬门：主人根本没被打扰', requesterCalls === 0);

  requester = async () => {
    requesterCalls += 1;
    return 'deny';
  };
  const denied = await call('edit', path.join(stranger, 'a.txt'));
  check('未授权：先问主人（问了一次）', requesterCalls === 1, `调用 ${requesterCalls} 次`);
  check('拒绝的理由写清楚了目标路径', denied?.block === true && denied.reason === `主人拒绝了：${path.join(stranger, 'a.txt')}`, denied?.reason ?? '(undefined)');

  requester = async () => 'once';
  const allowedOnce = await call('write', path.join(stranger, 'b.txt'));
  check('选「仅这次允许」：放行', allowedOnce === undefined);
  check('「仅这次允许」不会写进授权列表', readAllowedDirs().length === 0);

  requester = async () => 'dir';
  const allowedDir = await call('write', path.join(stranger, 'c.txt'));
  check('选「这个目录以后都允许」：这次放行', allowedDir === undefined);
  check('选的目录写进了 allowed-dirs.json', readAllowedDirs().length === 1 && readAllowedDirs()[0] === path.resolve(stranger), readAllowedDirs().join(' | '));
  const secondCallCallsBefore = requesterCalls;
  requester = async () => {
    requesterCalls += 1;
    return 'deny';
  };
  const afterGrant = await call('edit', path.join(stranger, 'd.txt'));
  check('授权之后同一目录不再问', afterGrant === undefined && requesterCalls === secondCallCallsBefore);

  // 超时：把探针用的超时调小，验"等超时 = 自动拒绝"这条路的理由
  process.env.PET_PI_APPROVAL_TIMEOUT_MS = '200';
  check('探针能把超时调小', approvalTimeoutMs() === 200, `${approvalTimeoutMs()} ms`);
  writeAllowedDirs([]);
  requester = (request) => new Promise<ApprovalDecision>((resolve) => {
    requesterCalls += 1;
    // 模拟"主人一直没操作"：只等超时那一刀
    request.signal?.addEventListener('abort', () => resolve('deny'), { once: true });
  });
  const timedOut = await call('edit', path.join(stranger, 'e.txt'));
  check(
    '超时 = 自动拒绝，理由里写明了超时',
    timedOut?.block === true && timedOut.reason === `主人拒绝了：${path.join(stranger, 'e.txt')}（等待超时，已自动拒绝）`,
    timedOut?.reason ?? '(undefined)',
  );
  check('超时之后不会留下授权记录', readAllowedDirs().length === 0);
  delete process.env.PET_PI_APPROVAL_TIMEOUT_MS;

  rmSync(tmp, { recursive: true, force: true });

  console.log('\n========================================');
  if (failures.length === 0) {
    console.log(`授权门探针：全部通过（${passed} 项）`);
    console.log('========================================');
    return;
  }
  console.log(`授权门探针：${failures.length} 项失败 / 共 ${passed + failures.length} 项`);
  for (const name of failures) console.error(`  - ${name}`);
  console.log('========================================');
  process.exitCode = 1;
}

void main().catch((error) => {
  console.error('\n[探针失败]');
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  process.exitCode = 1;
});
