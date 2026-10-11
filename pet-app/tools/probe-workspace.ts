/**
 * probe-workspace.ts —— 验"打包版也有一个能动手的工作目录"（零网络、零 API 成本、完全隔离）。
 *
 * 要验的 bug：打包版的 cwd 是启动时的当前目录（双击常常是 C:\Windows\System32），
 * 应用目录 resources\app 里又没有 src/main.ts，于是工作目录体检全不过 → 工具全关，
 * 用户看到的就是"能聊天，但不能读写文件"。
 *
 * 修法：候选全不过体检时，退回兜底工作区 <petRoot>\workspace（也开工具）；
 * 只有连兜底目录都建不出来，才退回"只能说话"。
 *
 * 隔离手段：PET_PI_ROOT 把 petRoot 整个指到临时目录 —— 所以兜底目录建在临时目录里，
 * **绝不会碰到你真实的 %APPDATA%\肆**；APPDATA 也一起指过去（checkpoint / 技能都跟着走）。
 * petRoot() / projectRoot() 都是惰性读环境变量的，所以在下面逐条改 env 就会立刻生效。
 *
 * 运行：npx tsx tools/probe-workspace.ts
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { describeWorkspace } from '../src/main/pi-engine';
import { decideApproval } from '../src/main/pi-approval';

const sandbox = path.join(os.tmpdir(), `si-probe-workspace-${Date.now()}`);

let failures = 0;

/** 一条断言。失败时打印可读原因（而不是只抛一个栈） */
function check(label: string, ok: boolean, detail: string): void {
  if (ok) {
    console.log(`✅ ${label}`);
    return;
  }
  failures += 1;
  console.error(`❌ ${label}`);
  console.error(`   原因：${detail}`);
}

/** 造一个"资料目录"：有 package.json 就够，hasSourceMain 决定要不要 src/main.ts */
function makeTree(name: string, hasSourceMain: boolean): string {
  const dir = path.join(sandbox, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), '{"name":"probe"}\n', 'utf8');
  if (hasSourceMain) {
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    writeFileSync(path.join(dir, 'src', 'main.ts'), '// probe\n', 'utf8');
  }
  return dir;
}

/** 目录自己或它的任一祖先里有 .git → 它在 git 仓库内部 */
function gitAncestor(dir: string): string | undefined {
  let current = path.resolve(dir);
  for (;;) {
    if (existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** 找一个"不存在的盘符"当不可写的 petRoot（Windows）；找不到就返回 undefined */
function missingDriveRoot(): string | undefined {
  for (const letter of 'QRSTUVWXYZ'.split('')) {
    const root = `${letter}:\\`;
    if (!existsSync(root)) return path.join(root, 'si-probe-petroot');
  }
  return undefined;
}

async function main(): Promise<void> {
  // 环境隔离：APPDATA / PET_PI_ROOT 全部指到临时目录，真实 %APPDATA%\肆 一个字节都不动
  const realAppData = process.env.APPDATA;   // 先记下真值：第 ⑤ 步要拿它做纯字符串检查
  const appData = path.join(sandbox, 'appdata');
  mkdirSync(appData, { recursive: true });
  process.env.APPDATA = appData;

  const sourceTree = makeTree('source-tree', true);          // 源码态
  const packagedApp = makeTree('packaged-app', false);       // 模拟 release\win-unpacked\resources\app
  // cwd 也要能换：打包版真机上 cwd 常常是 C:\Windows\System32（既不是源码树、也不是应用目录），
  // 所以模拟打包态时必须把 cwd 挪到一个"什么都不是"的目录，否则会误用探针自己的项目目录。
  const neutralCwd = path.join(sandbox, 'neutral-cwd');
  mkdirSync(neutralCwd, { recursive: true });
  const petRootOk = path.join(sandbox, 'petroot-ok');
  const petRootPriority = path.join(sandbox, 'petroot-priority');
  const petRootBlocked = path.join(sandbox, 'petroot-blocked');

  console.log(`临时沙箱 : ${sandbox}`);
  console.log(`模拟源码 : ${sourceTree}`);
  console.log(`模拟打包 : ${packagedApp}\n`);

  // ── 1. 源码态：PET_PI_WORKSPACE 指到合格源码目录 → 就用它 ──────────────────
  console.log('--- ① 源码态（dev / 主人显式指定源码目录）---');
  const startedCwd = process.cwd();
  process.env.PET_PI_ROOT = petRootOk;
  process.env.PET_PI_WORKSPACE = sourceTree;
  const source = describeWorkspace();
  check('用 PET_PI_WORKSPACE 指的那个目录', path.resolve(source.dir) === path.resolve(sourceTree),
    `期望 ${sourceTree}，实际 ${source.dir}`);
  check('allowTools = true', source.allowTools === true, `实际 ${source.allowTools}`);
  check('mode = "source"', source.mode === 'source', `实际 ${source.mode}`);
  check('工具白名单非空（含 read）', source.tools.includes('read'), `实际 ${JSON.stringify(source.tools)}`);

  // ①b：dev 的另一半 —— 没设 PET_PI_WORKSPACE 时，cwd（项目目录）本身就是合格工作目录
  delete process.env.PET_PI_WORKSPACE;
  const devByCwd = describeWorkspace();
  check('dev：不设 PET_PI_WORKSPACE 时用 cwd 这个项目目录',
    devByCwd.mode === 'source' && path.resolve(devByCwd.dir) === path.resolve(startedCwd),
    `mode=${devByCwd.mode} dir=${devByCwd.dir}（cwd=${startedCwd}）`);

  // 从这里开始模拟打包版：cwd 挪到一个什么都不是的目录
  process.chdir(neutralCwd);

  // ── 2. 打包态模拟：resources\app 只有 package.json，没有 src/main.ts ───────
  console.log('\n--- ② 打包态模拟（cwd 不是项目目录 + PET_PI_WORKSPACE = resources\\app 的样子）---');
  process.env.PET_PI_WORKSPACE = packagedApp;
  const packed = describeWorkspace();
  const fallbackDir = path.join(petRootOk, 'workspace');
  check('不再退化成"只能说话"：allowTools = true', packed.allowTools === true, `实际 ${packed.allowTools}`);
  check('mode = "fallback"', packed.mode === 'fallback', `实际 ${packed.mode}`);
  check(`用兜底工作区 <petRoot>\\workspace`, path.resolve(packed.dir) === path.resolve(fallbackDir),
    `期望 ${fallbackDir}，实际 ${packed.dir}`);
  check('工具白名单非空（含 read）', packed.tools.includes('read'), `实际 ${JSON.stringify(packed.tools)}`);
  check('兜底目录真的被创建了', existsSync(fallbackDir) && statSync(fallbackDir).isDirectory(),
    `${fallbackDir} 不存在或不是目录`);
  const readme = path.join(fallbackDir, 'README.txt');
  check('README.txt 真的被写了', existsSync(readme), `${readme} 不存在`);
  if (existsSync(readme)) {
    const text = readFileSync(readme, 'utf8');
    check('README.txt 有内容且说的是工作区', text.includes('工作区') && text.length > 50,
      `内容长度 ${text.length}，前 80 字：「${text.slice(0, 80)}」`);
  }

  // ── 3. 打包态 + 连 PET_PI_WORKSPACE 都没有（最接近真机的组合）────────────
  console.log('\n--- ③ 打包态模拟（连 PET_PI_WORKSPACE 都没有，cwd = 那个目录）---');
  const petRootCwd = path.join(sandbox, 'petroot-cwd');
  process.env.PET_PI_ROOT = petRootCwd;
  delete process.env.PET_PI_WORKSPACE;
  process.chdir(packagedApp);
  const packedCwd = describeWorkspace();
  process.chdir(neutralCwd);
  check('cwd 过不了体检时也走兜底 + 开工具', packedCwd.mode === 'fallback' && packedCwd.allowTools === true,
    `mode=${packedCwd.mode} allowTools=${packedCwd.allowTools} dir=${packedCwd.dir}`);
  check('兜底目录 = 该 petRoot 下的 workspace',
    path.resolve(packedCwd.dir) === path.resolve(path.join(petRootCwd, 'workspace')),
    `期望 ${path.join(petRootCwd, 'workspace')}，实际 ${packedCwd.dir}`);

  // ── 4. 优先级：合格源码目录绝不能被兜底覆盖（且兜底目录不该被建出来）──────
  console.log('\n--- ④ 优先级与"不白建目录"---');
  process.env.PET_PI_ROOT = petRootPriority;
  process.env.PET_PI_WORKSPACE = sourceTree;
  const priority = describeWorkspace();
  check('PET_PI_WORKSPACE 指向合格源码目录时用它', path.resolve(priority.dir) === path.resolve(sourceTree),
    `实际 ${priority.dir}`);
  check('没有被兜底覆盖（mode 仍是 source）', priority.mode === 'source', `实际 ${priority.mode}`);
  check('源码态下不新建兜底目录', !existsSync(path.join(petRootPriority, 'workspace')),
    `${path.join(petRootPriority, 'workspace')} 不应该存在`);
  // ④b：没有 PET_PI_WORKSPACE 时，cwd 是合格源码目录也必须赢过兜底
  delete process.env.PET_PI_WORKSPACE;
  process.chdir(startedCwd);
  const cwdWins = describeWorkspace();
  process.chdir(neutralCwd);
  check('合格源码目录（cwd）赢过兜底', path.resolve(cwdWins.dir) === path.resolve(startedCwd) && cwdWins.mode === 'source',
    `mode=${cwdWins.mode} dir=${cwdWins.dir}`);

  // ── 5. 不越界：兜底目录不是磁盘根 / 不是 petRoot 本身 / 不在 git 仓库里 ────
  console.log('\n--- ⑤ 兜底目录不越界---');
  check('不是磁盘根', path.resolve(packed.dir) !== path.resolve(path.parse(packed.dir).root),
    `实际 ${packed.dir}`);
  check('不是 petRoot 本身（是它的子目录 workspace）',
    path.resolve(packed.dir) !== path.resolve(petRootOk)
    && path.resolve(path.dirname(packed.dir)) === path.resolve(petRootOk),
    `dir=${packed.dir} petRoot=${petRootOk}`);
  const gitHit = gitAncestor(packed.dir);
  check('不在任何 git 仓库内部', gitHit === undefined, `命中了仓库 ${gitHit}`);
  // 真实部署路径也做一次纯字符串检查（不创建任何东西）：兜底目录不能在项目仓库里
  const repoRoot = path.resolve(startedCwd);
  const looksLikeRepo = existsSync(path.join(repoRoot, 'package.json')) && existsSync(path.join(repoRoot, 'src', 'main.ts'));
  if (looksLikeRepo) {
    const realFallback = path.join(realAppData ?? '', '肆', 'workspace');
    const relative = path.relative(repoRoot, realFallback);
    // 不同盘符时 path.relative 会返回绝对路径 —— 那也是"在仓库外"
    const outside = path.isAbsolute(relative) || relative.startsWith('..');
    check('真实兜底路径（%APPDATA%\\肆\\workspace）不在项目仓库内部',
      realAppData !== undefined && outside, `APPDATA=${realAppData}，${realFallback} → ${relative}`);
  } else {
    console.log('（跳过"真实兜底路径在仓库外"这条：当前 cwd 不像项目根目录）');
  }

  // ── 6. 安全网：连兜底目录都建不出来 → 静默退回"只能说话"，不抛异常 ────────
  console.log('\n--- ⑥ 安全网（兜底目录建不出来）---');
  process.env.PET_PI_WORKSPACE = packagedApp;

  // 6a：petRoot 是一个"文件"（mkdir 必然失败），跨平台且稳定
  writeFileSync(petRootBlocked, 'not a directory\n', 'utf8');
  process.env.PET_PI_ROOT = petRootBlocked;
  let blockedError: unknown;
  let blocked: ReturnType<typeof describeWorkspace> | undefined;
  try {
    blocked = describeWorkspace();
  } catch (error) {
    blockedError = error;
  }
  check('petRoot 被文件占住时不抛异常', blockedError === undefined,
    `抛了：${blockedError instanceof Error ? blockedError.message : String(blockedError)}`);
  if (blocked) {
    check('静默退回 allowTools = false', blocked.allowTools === false, `实际 ${blocked.allowTools}`);
    check('mode = "none"', blocked.mode === 'none', `实际 ${blocked.mode}`);
    check('工具全关（只能说话）', blocked.tools.length === 0, `实际 ${JSON.stringify(blocked.tools)}`);
  }

  // 6b：petRoot 指向不存在的盘符（Windows 真机上的"不可写位置"）
  const badRoot = process.platform === 'win32' ? missingDriveRoot() : undefined;
  if (badRoot) {
    process.env.PET_PI_ROOT = badRoot;
    let driveError: unknown;
    let onMissingDrive: ReturnType<typeof describeWorkspace> | undefined;
    try {
      onMissingDrive = describeWorkspace();
    } catch (error) {
      driveError = error;
    }
    check(`petRoot 指到不存在的盘符（${badRoot}）时不抛异常`, driveError === undefined,
      `抛了：${driveError instanceof Error ? driveError.message : String(driveError)}`);
    if (onMissingDrive) {
      check('不存在的盘符上静默退回 allowTools = false', onMissingDrive.allowTools === false,
        `实际 allowTools=${onMissingDrive.allowTools} mode=${onMissingDrive.mode} dir=${onMissingDrive.dir}`);
    }
  } else {
    console.log('（跳过"不存在的盘符"这条：没有可用的空盘符或不是 Windows）');
  }

  // ── 7. 安全语义不变：授权门照旧按"新的工作区根"判内外 ────────────────────
  // 授权门（pi-approval.ts）拿到的 cwd 就是 pi-engine 传给它的 workspace.dir，
  // 所以换工作目录之后它自动按新根判定 —— 这里直接对纯函数 decideApproval 断言。
  console.log('\n--- ⑦ 新工作区根的授权门语义---');
  process.env.PET_PI_ROOT = petRootOk;
  process.env.PET_PI_WORKSPACE = packagedApp;
  const current = describeWorkspace();
  const insideTarget = path.join(current.dir, 'notes.txt');
  const outsideTarget = path.join(os.tmpdir(), '别人的桌面', '报告.docx');
  const hardTarget = path.join(current.dir, '.env');
  check('工作区内的文件：直接放行（不问主人）',
    decideApproval({ cwd: current.dir, target: insideTarget, allowedDirs: [], toolName: 'edit' }) === 'allow',
    `实际 ${decideApproval({ cwd: current.dir, target: insideTarget, allowedDirs: [], toolName: 'edit' })}`);
  check('工作区外的文件：弹窗问主人（ask）',
    decideApproval({ cwd: current.dir, target: outsideTarget, allowedDirs: [], toolName: 'edit' }) === 'ask',
    `实际 ${decideApproval({ cwd: current.dir, target: outsideTarget, allowedDirs: [], toolName: 'edit' })}`);
  check('工作区里的 .env 仍然命中硬门（授权门也解不开）',
    decideApproval({ cwd: current.dir, target: hardTarget, allowedDirs: [], toolName: 'edit' }) === 'deny-hard',
    `实际 ${decideApproval({ cwd: current.dir, target: hardTarget, allowedDirs: [], toolName: 'edit' })}`);
  check('只读工具不受这道门影响',
    decideApproval({ cwd: current.dir, target: outsideTarget, allowedDirs: [], toolName: 'read' }) === 'allow',
    `实际 ${decideApproval({ cwd: current.dir, target: outsideTarget, allowedDirs: [], toolName: 'read' })}`);

  // ── 收尾 ─────────────────────────────────────────────────────────────────
  delete process.env.PET_PI_ROOT;
  delete process.env.PET_PI_WORKSPACE;
  process.chdir(startedCwd);
  rmSync(sandbox, { recursive: true, force: true });
  console.log(`\n（已清理临时目录 ${sandbox}）`);
  console.log(failures === 0 ? '\n全部断言通过 ✅' : `\n有 ${failures} 条断言失败 ❌`);
  if (failures > 0) process.exitCode = 1;
}

void main().catch((error) => {
  console.error('[探针失败]', error instanceof Error ? error.stack ?? error.message : String(error));
  rmSync(sandbox, { recursive: true, force: true });
  process.exitCode = 1;
});
