/**
 * pi-checkpoint.ts —— agent 动手前的自动存档 + 硬门拦截（阶段 E / F 的地基）。
 *
 * 核心承诺：**只要允许肆改，就必须能撤回。** 为此有两层存档：
 *
 *   第一层 · git 快照（只管它要动的那几个路径）
 *     一个回合里第一次要动文件之前存一次：
 *       · paths 非空、且是仓库内经 git 跟踪的文件
 *         → `git commit --no-verify -m "checkpoint(肆): <reason>" -- <paths>`
 *           提交里**只有这几个路径**的当前内容；不用 `git add -A`，也不碰索引
 *       · 这些路径没有改动（`git commit -- paths` 会以非 0 退出）→ 没有可提交的东西，
 *         退回记 `git rev-parse HEAD`（和"工作区干净"时是同一个分支）
 *       · paths 为空 / 全在仓库外 / 全是未跟踪的新文件 → 同样只记 HEAD，不产生提交
 *     撤回时用 `git checkout <ref> -- <paths>`，只还原快照覆盖过的那些路径。
 *
 *   第二层 · 文件副本（管仓库外的文件 + 新建的文件）
 *     每次要动的文件，先在 %APPDATA%\肆\pi-backups\<批次>\ 里复制一份；
 *     撤回时复制回去；如果是新建的文件，撤回时就删掉。
 *     → 这就是"桌宠能改桌面上/别的盘里的文件"还能撤回的关键。
 *
 * 为什么两层都要：git 只管得着仓库里的文件。桌宠要带工具性质（改用户随便哪个文件），
 * 就必须自己管副本 —— 否则"改坏了能回滚"这个承诺对仓库外的文件是假的。
 *
 * ⚠️ 这里修过的缺陷（原实现：`git add -A` 存快照 + `git reset --hard` 撤回）：
 *   · `git add -A` 会把工作区里**所有**无关改动一起卷进提交。实证：一个探针把真实的
 *     checkpoint 扩展挂到假 pi 上跑、cwd 指向真实仓库，于是 checkpoint 提交 7fc84c9 里
 *     塞进了 20 个文件 / 2870 行用户根本没打算提交的东西。
 *   · `git reset --hard <ref>` 是**整个工作区**级别的：撤回会连用户其它未提交的改动一起
 *     丢掉 —— 而那些改动从来没进过存档，丢了就真没了。
 *   新语义一句话：**只动它要动的文件；撤回只还原它动过的文件，不碰用户其它未提交改动。**
 *
 * 硬门（连授权都不放行，必须改代码才能解除）：
 *   .env / .git/ / node_modules/ / package-lock.json / .pet-builder.json
 *   —— 前两个是密钥和版本库，后三个是模板基础设施。
 *
 * TODO(下一步)：
 *   · 授权门：改工作目录**外**的文件前，在聊天窗口弹一次"允许/拒绝"（阶段 F 的 UX 层）
 *   · bash 没有 path 参数，放开 bash 时必须另做命令白名单
 */
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const execFileAsync = promisify(execFile);

/** 会被拦截并先存档的工具（只读工具不在其中） */
const MUTATING_TOOLS = new Set(['edit', 'write', 'bash']);

/** 硬门：agent 永远不许碰的路径片段 */
const PROTECTED_PATTERNS = ['.env', '.git/', 'node_modules/', 'package-lock.json', '.pet-builder.json'];

/** 被动的文件（或新建的文件）—— 撤回时要还原成什么样 */
export interface RevertFileEntry {
  /** 原始绝对路径 */
  original: string;
  /** 副本路径；original 本来不存在时为 undefined（撤回 = 删掉它） */
  backup?: string;
  /** 动手之前这个文件存在吗 */
  existed: boolean;
}

/** 一个"撤回点" = 一个用户回合里所有存档的集合 */
export interface CheckpointRecord {
  /** git 快照（仓库里的文件靠它还原）；没有仓库改动时也可能有 */
  ref?: string;
  at: string;
  cwd: string;
  reason: string;
  /** 这一回合动过的文件（仓库外的文件靠副本还原） */
  files?: RevertFileEntry[];
}

function petRoot(): string {
  // 和其它 petRoot（pi-engine / pi-companion / pi-approval）同一套约定：
  // 探针/测试用 PET_PI_ROOT 整个换掉桌宠数据目录，这样存档不会混进真实的
  // %APPDATA%\肆\pi-checkpoints.json 里。
  const override = (process.env.PET_PI_ROOT ?? '').trim();
  if (override.length > 0) return override;
  const root = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(root, '肆');
}

function statePath(): string {
  return path.join(petRoot(), 'pi-checkpoints.json');
}

function backupRoot(): string {
  return path.join(petRoot(), 'pi-backups');
}

export function readCheckpoints(): CheckpointRecord[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(statePath(), 'utf8'));
    return Array.isArray(parsed) ? (parsed as CheckpointRecord[]) : [];
  } catch {
    return [];
  }
}

function writeCheckpoints(records: CheckpointRecord[]): void {
  const file = statePath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(records.slice(-20), null, 2)}\n`, 'utf8');
}

/** 最近一次撤回点（可限定工作目录） */
export function readLatestCheckpoint(cwd?: string): CheckpointRecord | undefined {
  const records = readCheckpoints();
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record && (cwd === undefined || record.cwd === cwd)) return record;
  }
  return undefined;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, windowsHide: true });
  return stdout.trim();
}

/** 目标路径是否在工作目录内（含目录本身） */
export function isInsideWorkspace(cwd: string, target: string): boolean {
  const root = path.resolve(cwd);
  const resolved = path.resolve(root, target);
  return resolved === root || resolved.startsWith(root + path.sep);
}

/** 这个路径是否被 git 忽略（被忽略 = git 快照管不着 = 只能靠文件副本） */
export async function isGitIgnored(cwd: string, target: string): Promise<boolean> {
  try {
    // 退出码 0 = 被忽略；1 = 没被忽略（execFile 在非 0 退出时会 reject）
    await execFileAsync('git', ['check-ignore', '--quiet', '--', target], { cwd, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/** 这道门挡不挡这个路径（探针/诊断用） */
export function isProtectedPath(target: string): string | undefined {
  return PROTECTED_PATTERNS.find((pattern) => target.includes(pattern));
}

/** 把绝对路径变成副本目录里安全的相对路径：C:\a\b.txt → C\a\b.txt */
function backupPathFor(batchId: string, original: string): string {
  const parsed = path.parse(original);
  const drive = parsed.root.replace(/[:\\/]/g, '') || 'root';
  const rest = original.slice(parsed.root.length).split(/[\\/]/).filter((part) => part.length > 0);
  return path.join(backupRoot(), batchId, drive, ...rest);
}

/**
 * 把候选路径收敛成"git 快照管得着的路径"，并且用相对 cwd 的写法（git 只认这种）。
 * 三道过滤：仓库内 → 去重 → 已跟踪。
 *   · 仓库外的路径交给文件副本层：git 管不着它们，硬塞进 git 命令只会让整条命令失败
 *   · 未跟踪的新文件同样交给副本层：`git commit -- <未跟踪文件>` 会报
 *     "did not match any file(s) known to git" 并整条失败
 */
async function committablePaths(cwd: string, paths: string[]): Promise<string[]> {
  const root = path.resolve(cwd);
  const rels: string[] = [];
  const seen = new Set<string>();
  for (const candidate of paths) {
    if (typeof candidate !== 'string' || candidate.length === 0) continue;
    const absolute = path.resolve(root, candidate);
    if (!isInsideWorkspace(root, absolute)) continue;
    const rel = path.relative(root, absolute).split(path.sep).join('/');
    if (rel.length === 0 || rel === '.') continue;
    if (seen.has(rel)) continue;
    seen.add(rel);
    rels.push(rel);
  }
  if (rels.length === 0) return [];
  try {
    // -z：路径带空格/中文时不会被引号转义，直接按 \0 切；ls-files 的输出就是相对 cwd 的
    const { stdout } = await execFileAsync('git', ['ls-files', '-z', '--', ...rels], {
      cwd: root,
      windowsHide: true,
    });
    const tracked = new Set(stdout.split('\0').filter((entry) => entry.length > 0));
    return rels.filter((rel) => tracked.has(rel));
  } catch {
    // ls-files 都跑不动（cwd 根本不是仓库）→ 原样返回，让 commit 去尝试、失败、再退回 HEAD
    return rels;
  }
}

/**
 * git 快照：给 paths 里这些路径留一个 checkpoint 提交，然后记下那一刻的 SHA。
 *
 * 关键点：**不用 `git add -A`、也不 `git add`**。
 * `git commit -- <paths>`（等价于 --only）只把这几个路径的**工作区当前内容**写进提交，
 * 索引里别人暂存的东西原样不动 —— 所以用户没打算提交的改动不会被卷进来。
 *
 * 失败不致命（文件副本那一层还在），所以这里吞掉异常并返回 undefined。
 */
export async function createGitCheckpoint(
  cwd: string,
  reason: string,
  paths: string[] = [],
): Promise<string | undefined> {
  try {
    const targets = await committablePaths(cwd, paths);
    if (targets.length > 0) {
      try {
        await git(cwd, ['commit', '--no-verify', '-m', `checkpoint(肆): ${reason}`, '--', ...targets]);
      } catch {
        // 这些路径没有改动 → git 拒绝提交（"no changes added to commit" / pathspec 不匹配）。
        // 没有可提交的快照就退回记 HEAD —— 和以前"工作区干净"时的行为一致。
      }
    }
    return await git(cwd, ['rev-parse', 'HEAD']);
  } catch {
    return undefined;
  }
}

/** 兼容旧名字（探针在用）；paths 决定这个 git 快照覆盖哪些路径 */
export async function createCheckpoint(
  cwd: string,
  reason: string,
  paths: string[] = [],
): Promise<CheckpointRecord> {
  const ref = await createGitCheckpoint(cwd, reason, paths);
  const record: CheckpointRecord = { ref, at: new Date().toISOString(), cwd, reason };
  const records = readCheckpoints();
  records.push(record);
  writeCheckpoints(records);
  return record;
}

/**
 * 从快照提交里 checkout 回这些路径。
 * 只挑 `files[].original` 里**落在 cwd（仓库）内的绝对路径**：仓库外的文件由副本那一层
 * 负责，git 管不着（硬塞会给出一条 "outside repository" 的失败）。
 * 一条失败不中断整体；批量失败就逐个退让重试。
 */
async function restoreGitPaths(cwd: string, ref: string, files: RevertFileEntry[]): Promise<void> {
  const root = path.resolve(cwd);
  const rels: string[] = [];
  const seen = new Set<string>();
  for (const entry of files) {
    const original = entry?.original;
    if (typeof original !== 'string' || !path.isAbsolute(original)) continue;
    const absolute = path.resolve(original);
    if (!isInsideWorkspace(root, absolute)) continue;
    const rel = path.relative(root, absolute).split(path.sep).join('/');
    if (rel.length === 0 || rel === '.') continue;
    if (seen.has(rel)) continue;
    seen.add(rel);
    rels.push(rel);
  }
  if (rels.length === 0) return;

  try {
    await git(root, ['checkout', ref, '--', ...rels]);
    return;
  } catch {
    // 只要有一条路径在快照里不存在（这一回合新建的文件就是这样），git 会整条命令拒绝执行
    // —— 实测混合路径时连能还原的那条也不会动。所以退化成逐个重试：
    // 能还原的先还原，还原不了的交回给副本那一层（`existed: false` 的会被删掉）。
  }
  for (const rel of rels) {
    try {
      await git(root, ['checkout', ref, '--', rel]);
    } catch {
      // 单个路径失败不中断整体撤回；调用方可以从记录里看到这一回合动过哪些文件
    }
  }
}

/**
 * 撤回到最近一次撤回点：
 *   1. `git checkout <ref> -- <paths>`：**只还原快照覆盖过的仓库内路径**
 *      （不用 `git reset --hard`：那是整个工作区级别的，会连用户其它未提交改动一起丢）
 *   2. 再把这一回合动过的文件从副本复制回来（新建的文件删掉）—— 仓库外的文件全靠它
 *
 * 顺序不能反：第 1 步会把路径拉回**快照提交里的版本**（未必等于动手前的工作区版本，
 * 用户可能本来就有未提交改动），第 2 步随后用真正的"动手前内容"盖上它。
 */
export async function restoreLatestCheckpoint(cwd: string): Promise<CheckpointRecord | undefined> {
  const latest = readLatestCheckpoint(cwd);
  if (!latest) return undefined;

  if (latest.ref) {
    await restoreGitPaths(cwd, latest.ref, latest.files ?? []);
  }

  for (const entry of latest.files ?? []) {
    try {
      if (entry.existed && entry.backup && existsSync(entry.backup)) {
        mkdirSync(path.dirname(entry.original), { recursive: true });
        copyFileSync(entry.backup, entry.original);
      } else if (!entry.existed) {
        rmSync(entry.original, { force: true });
      }
    } catch {
      // 单个文件还原失败不该中断整体撤回；调用方可以从记录里看到有哪些文件
    }
  }

  return latest;
}

/** 把一条撤回点追加到记录文件（会话里由扩展调用；探针也用） */
export function appendCheckpoint(record: CheckpointRecord): void {
  const records = readCheckpoints();
  records.push(record);
  writeCheckpoints(records);
}

/** 给单个文件建立副本（会话里由扩展自动调用；探针也用） */
export function backupFile(batchId: string, target: string): RevertFileEntry {
  const existed = existsSync(target);
  if (!existed) return { original: target, existed };
  const backup = backupPathFor(batchId, target);
  mkdirSync(path.dirname(backup), { recursive: true });
  copyFileSync(target, backup);
  return { original: target, existed, backup };
}

/**
 * 装进 pi 会话的扩展。
 * - 硬门：受保护路径直接拦
 * - 一个回合第一次动文件前做 git 快照（只覆盖那一刻已知的目标路径）
 * - 每次要动的文件都先复制一份副本（仓库外的文件、新建的文件就靠这个才能撤回）
 */
export function createCheckpointExtension(options: { cwd: string }): (pi: ExtensionAPI) => void {
  return (pi: ExtensionAPI): void => {
    let gitCheckpointedThisTurn = false;
    let checkpointRef: string | undefined;
    let currentBatchId: string | undefined;
    let currentEntries: Map<string, RevertFileEntry> | undefined;

    function batch(): { id: string; entries: Map<string, RevertFileEntry> } {
      if (currentBatchId === undefined || currentEntries === undefined) {
        currentBatchId = new Date().toISOString().replace(/[:.]/g, '-');
        currentEntries = new Map<string, RevertFileEntry>();
      }
      return { id: currentBatchId, entries: currentEntries };
    }

    pi.on('tool_call', async (event) => {
      const toolName = typeof event.toolName === 'string' ? event.toolName : '';
      if (!MUTATING_TOOLS.has(toolName)) return undefined;

      const input = event.input as { path?: unknown } | undefined;
      const rawTarget = typeof input?.path === 'string' ? input.path : '';
      const target = rawTarget.length > 0 ? path.resolve(options.cwd, rawTarget) : '';

      // 硬门：受保护路径直接拦（这条连"授权"都不放行）
      const blocked = isProtectedPath(rawTarget) ?? isProtectedPath(target);
      if (blocked !== undefined) {
        return { block: true, reason: `受保护路径（命中「${blocked}」）不允许修改：${rawTarget}` };
      }

      // 第一层：一个回合只做一次 git 快照。
      // 快照只覆盖**此刻已知的目标路径** —— 第一次动手时只知道自己这一个路径，
      // 本回合后面才动到的文件不在这个提交里。这是有意为之的取舍：
      // 宁可快照窄一点（后动的文件由第二层文件副本兜底），也绝不再用 `git add -A`
      // 把用户的无关改动卷进提交（那正是 7fc84c9 那个事故）。
      if (!gitCheckpointedThisTurn) {
        gitCheckpointedThisTurn = true;
        checkpointRef = await createGitCheckpoint(
          options.cwd,
          `${toolName} 前自动存档`,
          target.length > 0 ? [target] : [],
        );
      }

      // 第二层：给这次要动的文件存副本（仓库外的文件全靠它）
      if (target.length > 0) {
        const { id, entries } = batch();
        if (!entries.has(target)) {
          const existed = existsSync(target);
          let backup: string | undefined;
          if (existed) {
            backup = backupPathFor(id, target);
            try {
              mkdirSync(path.dirname(backup), { recursive: true });
              copyFileSync(target, backup);
            } catch (error) {
              // 副本都存不下来，就不能让它动这个文件
              const message = error instanceof Error ? error.message : String(error);
              return { block: true, reason: `无法为 ${rawTarget} 建立副本，已阻止 ${toolName}：${message}` };
            }
          }
          entries.set(target, { original: target, backup, existed });
        }
      }

      return undefined;
    });

    // 回合结束：把这一回合的撤回点落盘（ref + 动过的文件；ref 是撤回时 git 那一步的依据）
    pi.on('agent_settled', async () => {
      if (currentBatchId !== undefined && currentEntries !== undefined && currentEntries.size > 0) {
        const records = readCheckpoints();
        records.push({
          ref: checkpointRef,
          at: new Date().toISOString(),
          cwd: options.cwd,
          reason: '动手前自动存档',
          files: [...currentEntries.values()],
        });
        writeCheckpoints(records);
      }
      gitCheckpointedThisTurn = false;
      checkpointRef = undefined;
      currentBatchId = undefined;
      currentEntries = undefined;
    });
  };
}
