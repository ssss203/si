/**
 * probe-checkpoint-scope.ts —— 证明"自动存档只动它要动的文件"（零 API 成本）。
 *
 * 背景（真实事故）：老的实现用 `git add -A` 存快照、用 `git reset --hard` 撤回，于是
 *   · 快照会把工作区里**所有**无关改动一起提交（checkpoint 提交 7fc84c9 里塞进了
 *     20 个文件 / 2870 行用户根本没打算提交的东西）；
 *   · 撤回会把用户**其它未提交的改动**一起丢掉（而那些改动从来没进过存档）。
 * 这个探针在一个**临时 git 仓库**里复现这两件事的场景，断言新实现都不会发生。
 *
 * 全程不花钱、不联网、不叫模型；记录文件也被隔离到临时目录：
 * PET_PI_ROOT / APPDATA 都指向临时目录（petRoot() 优先读 PET_PI_ROOT），
 * 跑完还会核对真实的 %APPDATA%\肆\pi-checkpoints.json 一个字节都没变。
 *
 * 运行：
 *   cd F:\ss_yong\si\pet-si\pet-app
 *   npx tsx tools/probe-checkpoint-scope.ts
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import {
  appendCheckpoint,
  createGitCheckpoint,
  readLatestCheckpoint,
  restoreLatestCheckpoint,
} from '../src/main/pi-checkpoint';

const execFileAsync = promisify(execFile);

// ── 断言工具：失败不中断（要看到全部结果），最后用退出码表态 ──────────────────
let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail.length > 0 ? `\n      ${detail}` : ''}`);
  if (!ok) failures += 1;
}

/** 内容比较一律吃掉换行符差异（Windows 上 core.autocrlf 会把 \n 落盘成 \r\n） */
function sameContent(actual: string, expected: string): boolean {
  return actual.replace(/\r\n/g, '\n').trim() === expected.replace(/\r\n/g, '\n').trim();
}

function contentOf(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '(读不到)';
  }
}

/** 文件指纹：用来证明真实的存档文件没被动过 */
function signatureOf(file: string): string {
  try {
    return createHash('sha256').update(readFileSync(file)).digest('hex');
  } catch {
    return '(不存在)';
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, windowsHide: true });
  return stdout.replace(/\r?\n$/, '');
}

async function statusPorcelain(cwd: string): Promise<string> {
  return (await git(cwd, ['status', '--porcelain'])).replace(/\r\n/g, '\n');
}

/** 一个提交改了哪些文件（比 git show --stat 更适合断言） */
async function commitPaths(cwd: string, ref: string): Promise<string[]> {
  const out = await git(cwd, ['show', '--name-only', '--pretty=format:', ref]);
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// 真实存档文件（在改 APPDATA 之前记下来）—— 探针结束时必须和它逐字节一致
const REAL_APPDATA = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
const REAL_STATE_FILE = path.join(REAL_APPDATA, '肆', 'pi-checkpoints.json');

const sandbox = path.join(os.tmpdir(), `si-checkpoint-scope-${Date.now()}-${process.pid}`);
const fakePetRoot = path.join(sandbox, 'pet-root');
const fakeAppData = path.join(sandbox, 'appdata');
const repo = path.join(sandbox, 'repo');

async function main(): Promise<void> {
  // ── 0) 隔离：碰任何存档函数之前，把桌宠数据目录挪进沙箱 ────────────────────
  const realStateBefore = signatureOf(REAL_STATE_FILE);
  process.env.PET_PI_ROOT = fakePetRoot;
  process.env.APPDATA = fakeAppData;
  mkdirSync(fakePetRoot, { recursive: true });
  mkdirSync(fakeAppData, { recursive: true });
  mkdirSync(repo, { recursive: true });

  console.log('========================================');
  console.log(`临时仓库    : ${repo}`);
  console.log(`隔离存档    : ${fakePetRoot}`);
  console.log(`真实存档    : ${REAL_STATE_FILE}（只读，跑完核对指纹）`);
  console.log('========================================');

  // ── 1) 基线仓库 ────────────────────────────────────────────────────────────
  await git(repo, ['init', '--quiet']);
  await git(repo, ['config', 'user.email', 'probe@si.local']); // 只写本地配置，不动 --global
  await git(repo, ['config', 'user.name', 'si-probe']);

  const aFile = path.join(repo, 'a.txt');
  const bFile = path.join(repo, 'b.txt');
  const unrelated = path.join(repo, 'unrelated.txt');
  writeFileSync(aFile, 'A-基线\n', 'utf8');
  writeFileSync(bFile, 'B-基线\n', 'utf8');
  await git(repo, ['add', '--', 'a.txt', 'b.txt']);
  await git(repo, ['commit', '--quiet', '--no-verify', '-m', 'baseline']);
  const base = await git(repo, ['rev-parse', 'HEAD']);

  // 用户的无关改动：未跟踪、用户根本没打算提交
  writeFileSync(unrelated, '用户随手写的，不许被卷进任何 checkpoint 提交\n', 'utf8');

  // ── 2) 快照范围：只提交目标路径 ────────────────────────────────────────────
  console.log('\n--- 第一部分：快照只提交目标路径 ---');
  writeFileSync(aFile, 'A-目标改动\n', 'utf8'); // 目标文件此刻有未提交改动
  const ref1 = await createGitCheckpoint(repo, 'probe: 只提交目标路径', ['a.txt']);
  const head1 = await git(repo, ['rev-parse', 'HEAD']);
  const touched = await commitPaths(repo, 'HEAD');

  check('①-a 产生了快照提交（不是退回基线 HEAD）', ref1 !== undefined && ref1 !== base, `ref=${ref1?.slice(0, 7)}  base=${base.slice(0, 7)}`);
  check('①-b 返回的 ref 就是那个提交', ref1 === head1 && ref1 !== undefined);
  check('①-c 快照提交里**只有** a.txt', touched.length === 1 && touched[0] === 'a.txt', `实际: [${touched.join(', ') || '空'}]`);
  check('①-d 提交里没有 unrelated.txt（老实现会把它一起 add -A 进去）', !touched.includes('unrelated.txt'));
  const ref1B = await git(repo, ['show', `HEAD:b.txt`]);
  check('①-e 反证：快照提交里 b.txt 还是基线版本 → 老实现的 reset --hard 会抹掉 b.txt 的改动', sameContent(ref1B, 'B-基线'), `快照里的 b.txt = 「${ref1B.trim()}」`);
  check('②-a unrelated.txt 仍未提交', (await statusPorcelain(repo)).includes('?? unrelated.txt'), `status:\n${await statusPorcelain(repo)}`);

  // ── 3) 没有改动 / 空路径 / 未跟踪新文件 → 只记 HEAD，不产生提交 ─────────────
  console.log('\n--- 第二部分：没得提交时退回记 HEAD（不产生多余提交） ---');
  const ref2 = await createGitCheckpoint(repo, 'probe: 目标路径没有改动', ['b.txt']);
  check('（补）已跟踪但没改动 → 不提交，记 HEAD', ref2 === head1 && (await git(repo, ['rev-parse', 'HEAD'])) === head1);
  const ref3 = await createGitCheckpoint(repo, 'probe: paths 为空', []);
  check('（补）paths 为空 → 不提交，记 HEAD', ref3 === head1 && (await git(repo, ['rev-parse', 'HEAD'])) === head1);
  const ref4 = await createGitCheckpoint(repo, 'probe: 未跟踪的新文件', ['unrelated.txt']);
  check('（补）未跟踪的新文件 → git 管不着，不提交、不报错，记 HEAD', ref4 === head1 && (await git(repo, ['rev-parse', 'HEAD'])) === head1);
  const ref5 = await createGitCheckpoint(repo, 'probe: 混合路径', ['a.txt', 'b.txt', 'unrelated.txt', 'D:\\仓库外\\别处.txt']);
  check('（补）混合路径（干净的 + 未跟踪的 + 仓库外的）→ 一个提交都不产生', ref5 === head1 && (await git(repo, ['rev-parse', 'HEAD'])) === head1);
  check('②-b 以上都没碰 unrelated.txt', (await statusPorcelain(repo)).includes('?? unrelated.txt'));

  // ── 4) 撤回范围：只还原快照覆盖过的路径 ────────────────────────────────────
  console.log('\n--- 第三部分：撤回只还原它动过的文件 ---');
  const refForRestore = ref1 as string;
  appendCheckpoint({
    ref: refForRestore,
    at: new Date().toISOString(),
    cwd: repo,
    reason: 'probe: 撤回范围',
    files: [{ original: aFile, existed: true }], // 快照只覆盖 a.txt
  });
  check('撤回点已落盘（写进隔离目录，不是真实 %APPDATA%）', readLatestCheckpoint(repo)?.ref === refForRestore);
  check('（隔离）记录文件在临时 PET_PI_ROOT 下', existsSync(path.join(fakePetRoot, 'pi-checkpoints.json')), `期望存在: ${path.join(fakePetRoot, 'pi-checkpoints.json')}`);
  check('（隔离）PET_PI_ROOT 生效时不会去写 APPDATA 目录', !existsSync(path.join(fakeAppData, '肆', 'pi-checkpoints.json')));

  // 模拟"动手"：a.txt 被改（快照覆盖它），b.txt 也被改（快照没覆盖它）
  writeFileSync(aFile, 'A-被肆改过\n', 'utf8');
  writeFileSync(bFile, 'B-被肆改过\n', 'utf8');
  const unrelatedBefore = contentOf(unrelated);

  const restored = await restoreLatestCheckpoint(repo);
  const statusAfter = await statusPorcelain(repo);

  check('③-a a.txt 回到快照那一刻的内容', sameContent(contentOf(aFile), 'A-目标改动'), `实际:「${contentOf(aFile).trim()}」`);
  check('③-b 撤回返回的就是那条记录', restored?.ref === refForRestore);
  check('④-a b.txt **保持被改后的内容**（快照没包含它，撤回不许顺手抵消）', sameContent(contentOf(bFile), 'B-被肆改过'), `实际:「${contentOf(bFile).trim()}」`);
  check('④-b b.txt 的改动还留在工作区里', statusAfter.includes(' M b.txt'), `status:\n${statusAfter}`);
  check('⑤-a unrelated.txt 还在，内容一字未动', existsSync(unrelated) && sameContent(contentOf(unrelated), unrelatedBefore), `实际:「${contentOf(unrelated).trim()}」`);
  check('⑤-b unrelated.txt 依旧是未跟踪状态（既没被提交也没被删）', statusAfter.includes('?? unrelated.txt'), `status:\n${statusAfter}`);

  // ── 5) 仓库外的路径：git 那一步必须整个跳过，不能报错 ──────────────────────
  console.log('\n--- 第四部分：仓库外的路径交给文件副本层，git 不插手 ---');
  const outside = path.join(sandbox, '外面', '试验文件.txt');
  mkdirSync(path.dirname(outside), { recursive: true });
  writeFileSync(outside, '仓库外的文件，git 管不着\n', 'utf8');
  writeFileSync(aFile, 'A-又被改了一次\n', 'utf8');
  appendCheckpoint({
    ref: refForRestore,
    at: new Date().toISOString(),
    cwd: repo,
    reason: 'probe: 仓库外路径',
    files: [{ original: outside, existed: true }], // 没有副本 → 副本层也不该动它
  });
  let outsideThrew = '';
  try {
    await restoreLatestCheckpoint(repo);
  } catch (error) {
    outsideThrew = error instanceof Error ? error.message : String(error);
  }
  check('（补）仓库外路径不会让撤回抛异常', outsideThrew.length === 0, outsideThrew);
  check('（补）仓库外的文件没被 git 动过', sameContent(contentOf(outside), '仓库外的文件，git 管不着'));
  check('（补）这条记录里没有仓库内路径 → git 那一步确实没跑（a.txt 保持被改的样子）', sameContent(contentOf(aFile), 'A-又被改了一次'), `实际:「${contentOf(aFile).trim()}」`);

  // ── 6) 本回合新建的文件：批量 checkout 会整条失败 → 逐个退让 + 副本层删掉 ──
  console.log('\n--- 第五部分：新建的文件（快照里不存在）不拖垮其它路径 ---');
  const newFile = path.join(repo, 'new-by-pet.txt');
  writeFileSync(aFile, 'A-第三次被改\n', 'utf8');
  writeFileSync(newFile, '肆新建的\n', 'utf8');
  appendCheckpoint({
    ref: refForRestore,
    at: new Date().toISOString(),
    cwd: repo,
    reason: 'probe: 新建文件',
    // a.txt：没有副本 → 只能靠 git 还原；new-by-pet.txt：快照里不存在 + existed:false → 副本层删掉
    files: [
      { original: aFile, existed: true },
      { original: newFile, existed: false },
    ],
  });
  let newThrew = '';
  try {
    await restoreLatestCheckpoint(repo);
  } catch (error) {
    newThrew = error instanceof Error ? error.message : String(error);
  }
  check('（补）混合"存在过 + 新建"的撤回不抛异常', newThrew.length === 0, newThrew);
  check('（补）批量 checkout 失败后逐个重试，a.txt 仍然还原了', sameContent(contentOf(aFile), 'A-目标改动'), `实际:「${contentOf(aFile).trim()}」`);
  check('（补）本回合新建的文件被副本层删掉', !existsSync(newFile));

  // ── 7) 真实项目的形状：cwd 是 git 根的子目录（pet-si / pet-app）────────────
  console.log('\n--- 第六部分：cwd 在仓库子目录里（真实项目就是这样） ---');
  const repo2 = path.join(sandbox, 'nested-repo');
  const inner = path.join(repo2, 'inner');
  mkdirSync(inner, { recursive: true });
  await git(repo2, ['init', '--quiet']);
  await git(repo2, ['config', 'user.email', 'probe@si.local']);
  await git(repo2, ['config', 'user.name', 'si-probe']);

  const rootFile = path.join(repo2, 'user-at-root.txt'); // 仓库根、但**在工作目录之外**
  const innerA = path.join(inner, 'a.txt');
  const innerB = path.join(inner, 'b.txt');
  writeFileSync(rootFile, '仓库根-基线\n', 'utf8');
  writeFileSync(innerA, 'inner-a-基线\n', 'utf8');
  writeFileSync(innerB, 'inner-b-基线\n', 'utf8');
  await git(repo2, ['add', '-A']);
  await git(repo2, ['commit', '--quiet', '--no-verify', '-m', 'baseline']);

  writeFileSync(rootFile, '仓库根-用户改的（工作目录之外）\n', 'utf8'); // 老实现会把它卷进提交
  writeFileSync(innerA, 'inner-a-目标改动\n', 'utf8');
  const refN = await createGitCheckpoint(inner, 'probe: 子目录 cwd', [innerA]);
  const touchedN = await commitPaths(repo2, 'HEAD');
  const statusN = await statusPorcelain(repo2);

  check('（补）cwd 在子目录时，快照提交里只有那个目标路径', touchedN.length === 1 && touchedN[0]?.endsWith('a.txt') === true, `实际: [${touchedN.join(', ') || '空'}]`);
  check('（补）仓库根的无关改动没被卷进快照（老实现从子目录 `add -A` 也是一整个仓库）', !touchedN.some((line) => line.includes('user-at-root')));
  check('（补）仓库根的无关改动仍然是未提交状态', statusN.includes(' M user-at-root.txt'), `status:\n${statusN}`);
  const rootInCommit = await git(repo2, ['show', 'HEAD:user-at-root.txt']);
  check('（补）反证：快照里仓库根的文件还是基线版本 → 老实现的 reset --hard 会抹掉用户那次改动', sameContent(rootInCommit, '仓库根-基线'));

  appendCheckpoint({
    ref: refN as string,
    at: new Date().toISOString(),
    cwd: inner, // 记录用的 cwd 是工作目录（子目录），和扩展里一致
    reason: 'probe: 子目录撤回范围',
    files: [{ original: innerA, existed: true }],
  });
  writeFileSync(innerA, 'inner-a-被肆改过\n', 'utf8');
  writeFileSync(innerB, 'inner-b-被肆改过\n', 'utf8');
  await restoreLatestCheckpoint(inner);

  check('（补）子目录里的靶子还原了', sameContent(contentOf(innerA), 'inner-a-目标改动'), `实际:「${contentOf(innerA).trim()}」`);
  check('（补）子目录里快照没覆盖的文件保持被改后的样子', sameContent(contentOf(innerB), 'inner-b-被肆改过'));
  check('（补）仓库根上用户的改动照样在（老实现的 reset --hard 会把它丢掉）', sameContent(contentOf(rootFile), '仓库根-用户改的（工作目录之外）'), `实际:「${contentOf(rootFile).trim()}」`);

  // ── 8) 隔离核对 + 清理 ────────────────────────────────────────────────────
  console.log('\n--- 第七部分：隔离核对 ---');
  check('（隔离）真实的 %APPDATA%\\肆\\pi-checkpoints.json 一个字节都没变', signatureOf(REAL_STATE_FILE) === realStateBefore);

  rmSync(sandbox, { recursive: true, force: true });
  console.log(`\n（已清理临时目录 ${sandbox}）`);

  console.log('\n========================================');
  console.log(failures === 0 ? '全部断言通过 ✅' : `${failures} 条断言失败 ❌`);
  console.log('========================================');
  if (failures > 0) process.exitCode = 1;
}

void main().catch((error) => {
  console.error('\n[探针失败]');
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  rmSync(sandbox, { recursive: true, force: true });
  process.exitCode = 1;
});
