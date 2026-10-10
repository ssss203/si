/**
 * pi-approval.ts —— 「授权门」（阶段 F 的 UX 层）：改工作目录**外**的文件前，问主人一次。
 *
 * 三条规则（用户定的设计，这里逐条落地）：
 *   1. 目标在**工作目录内** → 和以前一样，不问（那是它的活儿）。
 *   2. 目标在**工作目录外**、且所在目录**不在已授权列表**里 → 弹小窗问主人：
 *      [仅这次允许] [这个目录以后都允许] [拒绝]，60 秒不操作 = 自动拒绝。
 *   3. 目标命中**硬门**（.env / .git/ / node_modules/ / package-lock.json / .pet-builder.json）
 *      → 连问都不问，直接拒绝。授权门**不能**解锁硬门（硬门清单在 pi-checkpoint.ts，
 *      这里 import 它的 isProtectedPath，保证只有一份定义）。
 *
 * 为什么判定逻辑要和"弹窗"分开：
 *   decideApproval() 是纯函数（无 IO、无 Electron），所以 tools/probe-approval.ts
 *   能零 API 成本地把它和 allowed-dirs 的读写全覆盖一遍 —— 能这么测的才是真逻辑。
 *
 * 为什么这个扩展要注册在 pi-checkpoint **之前**（pi-engine.ts 的 extensionFactories 顺序）：
 *   pi 的 tool_call 处理器按注册顺序**串行**跑，第一个返回 { block: true } 的立刻短路
 *   （见 dist/core/extensions/runner.js 的 emitToolCall）。授权门排在最前，被拒绝的路径
 *   就不会白做 git 快照和文件副本 —— 顺序错了不会漏掉拦截，但会留下没人要的存档。
 *
 * ⚠️ 老规矩：pi 是纯 ESM，静态导入只留 `import type`（编译期擦除）。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { ApprovalDecision } from '../shared/contracts';
import { isProtectedPath } from './pi-checkpoint';

/** 这道门只管"能改文件"的工具。bash 没有 path 参数，要管它得另做命令白名单，不在这一版里。 */
const PATH_TOOLS = new Set(['edit', 'write']);

/** 60 秒不操作 = 自动拒绝（窗口倒计时和这里的计时用同一个函数取，只有一个来源） */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 60_000;

/**
 * 实际的自动拒绝超时。
 * 默认 60 秒；探针可以用 PET_PI_APPROVAL_TIMEOUT_MS 调小（200ms 就能验完"超时"那条路），
 * 这个口子和 petRoot() 的 PET_PI_ROOT 一个性质：只为可测性，不改变默认行为。
 */
export function approvalTimeoutMs(): number {
  const raw = Number((process.env.PET_PI_APPROVAL_TIMEOUT_MS ?? '').trim());
  return Number.isFinite(raw) && raw >= 100 ? Math.round(raw) : DEFAULT_APPROVAL_TIMEOUT_MS;
}

/** 授权目录路径的长度上限（Windows 长路径也就 300 出头，再长只可能是坏输入） */
const MAX_DIR_LENGTH = 320;

/** 这道门的判定结果：放行 / 问主人 / 硬门直接拒 */
export type ApprovalVerdict = 'allow' | 'ask' | 'deny-hard';

/** 扩展要问主人的东西 */
export interface ApprovalRequest {
  toolName: string;
  /** 目标文件绝对路径 */
  path: string;
  /** 目标文件所在目录（"这个目录以后都允许"授权的就是它） */
  dir: string;
  /** 授权门超时/这一轮被中止时会 abort 它：主进程收到后关窗并拒绝 */
  signal?: AbortSignal;
}

/** 问主人的通道：由 pi-engine.ts 从"当前这一轮"的 PiChatStreamOptions 里取 */
export type RequestApproval = (request: ApprovalRequest) => Promise<ApprovalDecision>;

// ─────────────────────────────────────────────────────────────────────────────
// 纯逻辑：判定
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 硬门命中检查：返回命中的路径片段，没有就是 undefined。
 *
 * 注意把反斜杠统一成 `/` 再查 —— 硬门清单里写的是 `node_modules/`、`.git/`，
 * 而 Windows 的 path.resolve 产出的是反斜杠路径，不统一就会漏（这是既有实现的坑，
 * 这里补上；pi-checkpoint.ts 的硬门清单本身不动）。
 */
export function hardGateHit(target: string): string | undefined {
  return isProtectedPath(target) ?? isProtectedPath(target.replace(/\\/g, '/'));
}

/** 比较用的键：Windows 上大小写不敏感，统一小写；其它平台原样 */
function compareKey(target: string): string {
  const resolved = path.resolve(target);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** child 是不是等于 parent 或在 parent 里面（大小写/盘符都交给 path.relative 判） */
function isInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * 这个目录是不是"已授权"。
 * 授权的是**整棵子树**（点了"这个目录以后都允许"，主人期待的是这个目录里的文件都能改，
 * 而不是只有贴着根的那一层）。
 */
export function isDirAllowed(dir: string, allowedDirs: readonly string[]): boolean {
  return allowedDirs.some((allowed) => {
    try {
      return isInside(allowed, dir);
    } catch {
      return false;
    }
  });
}

/**
 * 授权门的判定（纯函数，探针直接测这个）。
 *
 * 顺序很重要：**硬门先判** —— 否则把 `C:\Users\me` 授权出去就等于解锁了里面的 .env。
 */
export function decideApproval(options: {
  cwd: string;
  target: string;
  allowedDirs: readonly string[];
  /** 不传 = 按"会改文件"处理；只读工具直接放行（这道门不管读） */
  toolName?: string;
}): ApprovalVerdict {
  if (options.toolName !== undefined && !PATH_TOOLS.has(options.toolName)) return 'allow';

  const raw = options.target;
  if (raw.trim().length === 0) return 'allow';
  const absolute = path.resolve(options.cwd, raw);

  if (hardGateHit(raw) !== undefined || hardGateHit(absolute) !== undefined) return 'deny-hard';
  if (isInside(options.cwd, absolute)) return 'allow';
  if (isDirAllowed(path.dirname(absolute), options.allowedDirs)) return 'allow';
  return 'ask';
}

// ─────────────────────────────────────────────────────────────────────────────
// 已授权目录的读写（%APPDATA%\肆\allowed-dirs.json）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * allowed-dirs.json 的路径。
 *   默认：%APPDATA%\肆\allowed-dirs.json
 *   探针可以用 PET_PI_ALLOWED_DIRS 直接换掉这个文件，或用 PET_PI_ROOT 换掉整个桌宠
 *   数据目录（和 pi-engine.ts 是同一个变量名，测试时一起生效）。
 */
export function allowedDirsFile(): string {
  const explicit = (process.env.PET_PI_ALLOWED_DIRS ?? '').trim();
  if (explicit.length > 0) return path.resolve(explicit);
  const root = (process.env.PET_PI_ROOT ?? '').trim();
  const base = root.length > 0
    ? root
    : path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), '肆');
  return path.join(base, 'allowed-dirs.json');
}

/**
 * IPC / 文件内容里来的目录一律过这里：绝对路径、不是磁盘根、长度上限。
 * 磁盘根必须挡掉 —— 授权 `C:\` 等于把整台机器交出去（到时候硬门是唯一的防线，太薄）。
 */
export function assertAllowedDir(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('授权目录必须是字符串');
  const raw = value.trim();
  if (raw.length === 0) throw new TypeError('授权目录不能是空字符串');
  if (raw.length > MAX_DIR_LENGTH) throw new TypeError(`授权目录太长了（上限 ${MAX_DIR_LENGTH} 字符）`);
  if (raw.includes('\u0000')) throw new TypeError('授权目录里不能有空字符');
  if (!path.isAbsolute(raw)) throw new TypeError('授权目录必须是绝对路径');

  const resolved = path.resolve(raw);
  const { root } = path.parse(resolved);
  if (resolved === root || resolved === root.replace(/[\\/]+$/, '')) {
    throw new TypeError('不能把整个磁盘根目录授权出去，请选一个具体的文件夹');
  }
  return resolved;
}

/** 规范化 + 去重（Windows 上按小写比较），坏条目直接丢掉 */
function normalizeAllowedDirs(values: readonly unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    let resolved: string;
    try {
      resolved = assertAllowedDir(value);
    } catch {
      continue;
    }
    const key = compareKey(resolved);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(resolved);
  }
  return out;
}

/** 读已授权目录：文件不存在/坏掉/不是数组都当"一个都没授权" */
export function readAllowedDirs(): string[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(allowedDirsFile(), 'utf8'));
    return Array.isArray(parsed) ? normalizeAllowedDirs(parsed) : [];
  } catch {
    return [];
  }
}

/** 写已授权目录（临时文件 + rename，避免写到一半断电留下半个 JSON） */
export function writeAllowedDirs(dirs: readonly unknown[]): string[] {
  const file = allowedDirsFile();
  const normalized = normalizeAllowedDirs(dirs);
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  renameSync(temporary, file);
  return normalized;
}

/** 追加一个授权目录（已存在就不重复加），返回写完之后的完整列表 */
export function addAllowedDir(dir: unknown): string[] {
  const resolved = assertAllowedDir(dir);
  const key = compareKey(resolved);
  const current = readAllowedDirs();
  if (current.some((item) => compareKey(item) === key)) return current;
  return writeAllowedDirs([...current, resolved]);
}

/**
 * 撤销一个授权目录。
 *
 * 除了它自己，**它里面的条目也一起撤掉** —— 授权是整棵子树的语义，如果撤销 `C:\a`
 * 之后 `C:\a\b` 还留在列表里，主人会以为已经收回去了，实际肆照样能改。
 * 安全功能里"少授权"永远比"多留一条"好。
 */
export function removeAllowedDir(dir: unknown): string[] {
  const resolved = assertAllowedDir(dir);
  const remaining = readAllowedDirs().filter((item) => !isInside(resolved, item));
  return writeAllowedDirs(remaining);
}

// ─────────────────────────────────────────────────────────────────────────────
// 装进 pi 会话的扩展
// ─────────────────────────────────────────────────────────────────────────────

/** 问主人：超时/异常一律当拒绝，理由写清楚（让肆能转告主人，而不是静默失败） */
async function askMaster(options: {
  request: RequestApproval | undefined;
  toolName: string;
  target: string;
  dir: string;
}): Promise<{ block: true; reason: string } | undefined> {
  if (!options.request) {
    // fail-closed：没人可问（没有活动轮次 / 主进程没接授权通道）就不放行
    return {
      block: true,
      reason: `没人可以问（授权通道不可用），已阻止修改工作目录外的文件：${options.target}`,
    };
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, approvalTimeoutMs());

  let decision: ApprovalDecision = 'deny';
  try {
    decision = await options.request({
      toolName: options.toolName,
      path: options.target,
      dir: options.dir,
      signal: controller.signal,
    });
  } catch {
    // 窗口炸了 / 主进程拒绝了这个请求：按拒绝处理，理由用超时那句更接近事实的兜底
    decision = 'deny';
  } finally {
    clearTimeout(timer);
  }

  if (decision === 'once') return undefined;
  if (decision === 'dir') {
    try {
      addAllowedDir(options.dir);
    } catch {
      // 记不下来不影响这一次放行（下次还会再问一遍，安全方向是对的）
    }
    return undefined;
  }
  return {
    block: true,
    reason: `主人拒绝了：${options.target}${timedOut ? '（等待超时，已自动拒绝）' : ''}`,
  };
}

/**
 * 授权门扩展。
 * `getRequester` 由 pi-engine.ts 传进来，它读的是"当前这一轮"的授权通道（模块级 holder）。
 */
export function createApprovalExtension(options: {
  cwd: string;
  getRequester: () => RequestApproval | undefined;
}): (pi: ExtensionAPI) => void {
  return (pi: ExtensionAPI): void => {
    pi.on('tool_call', async (event) => {
      const toolName = typeof event.toolName === 'string' ? event.toolName : '';
      if (!PATH_TOOLS.has(toolName)) return undefined;

      const input = event.input as { path?: unknown } | undefined;
      const rawTarget = typeof input?.path === 'string' ? input.path : '';
      if (rawTarget.length === 0) return undefined;

      const target = path.resolve(options.cwd, rawTarget);
      // 每次都重新读盘：主人在面板上撤销授权之后，下一次调用就该重新弹窗
      const verdict = decideApproval({
        cwd: options.cwd,
        target: rawTarget,
        allowedDirs: readAllowedDirs(),
        toolName,
      });

      if (verdict === 'allow') return undefined;
      if (verdict === 'deny-hard') {
        const hit = hardGateHit(rawTarget) ?? hardGateHit(target) ?? '受保护路径';
        return {
          block: true,
          reason: `受保护路径（命中「${hit}」）不允许修改：${rawTarget}（硬门不能用授权解锁）`,
        };
      }

      const dir = path.dirname(target);
      return askMaster({
        request: options.getRequester(),
        toolName,
        target,
        dir,
      });
    });
  };
}
