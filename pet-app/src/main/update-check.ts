/**
 * update-check.ts —— 「检查更新」：启动时最多每周问一次 GitHub，有新版本就提醒主人。
 *
 * ── 三条硬规矩（这个文件的存在意义就是把它们钉死）─────────────────────────────
 *   1. 【最多每周一次】状态落在 `%APPDATA%\肆\update-check.json`，距上次检查不足
 *      CHECK_INTERVAL_MS（7 天）就一次网络请求都不发。
 *   2. 【同一个新版本只提示一次】`lastNotifiedVersion` 记住"已经喊过的那个版本"，
 *      再启动就不重复弹了 —— 再烦人也不能变成每次开机弹一次。
 *   3. 【拿不准就不提示】版本比较用纯函数 `compareVersions`，遇到解析不了的字符串
 *      （`abc` / `1.0` / 空串 / 带后缀的 tag）**一律返回"不提示"**：
 *      宁可漏报一个真有新版本的情形，也不能因为解析混乱去催主人下载一个不存在的东西。
 *
 * ── 数据源：GitHub 公开 API（不是 latest.yml）────────────────────────────────
 *   用 `https://api.github.com/repos/ssss203/si/releases/latest` 的 `tag_name`。
 *   理由：
 *     · `tag_name` 是 JSON 里的一个字段，取值只有 `v1.0.0` 这种标签；而 latest.yml 是给
 *       electron-updater 用的 YAML，为了它得自己手写 YAML 解析（引号/换行/嵌套一多就容易
 *       解析错）—— 拿不准的解析正是这个功能最怕的东西。
 *     · 匿名调用 60 次/小时/IP，我们是"每 7 天 1 次"，连零头都用不到。
 *     · 不需要 key、不需要登录（仓库是 public 的）。
 *   失败（离线 / 403 限流 / JSON 坏 / 8 秒超时）一律静默 + 不写坏状态，见 runUpdateCheck。
 *
 * ── 可测性 ───────────────────────────────────────────────────────────────────
 *   这个模块**不 import electron**：`app.getVersion()`、`sendActivity()`、`logger` 全部
 *   由 main.ts 注入。于是 tools/probe-update-check.ts 能零网络、零 Electron 地把它跑通。
 *
 * ── 调试/测试用环境变量（照项目既有 PET_PI_* 风格）─────────────────────────────
 *   PET_UPDATE_CHECK=off    完全不查（连状态文件都不读写）
 *   PET_UPDATE_CHECK=force  忽略 7 天限制，立刻查一次（**只用于手工调试**，别常驻设置）
 *   PET_UPDATE_CHECK_ROOT   换掉状态文件所在目录（探针用它指到临时目录，绝不碰真实 %APPDATA%\肆）
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── 常量 ─────────────────────────────────────────────────────────────────────

/** 最新的 release（`tag_name` 就在这个 JSON 里）。不带 key、不带 token。 */
export const LATEST_RELEASE_API = 'https://api.github.com/repos/ssss203/si/releases/latest';

/**
 * 点「去下载」打开的地址。**写死在主进程**，永远不接受 renderer 传来的 URL
 * （否则那个 IPC 就成了"帮我打开任意链接"的通用后门）。
 */
export const RELEASES_PAGE_URL = 'https://github.com/ssss203/si/releases/latest';

/** 检查间隔：7 天。 */
export const CHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/** 启动后延迟多久再查（别和启动抢资源，也别和桌宠首次绘制抢）。 */
export const STARTUP_DELAY_MS = 30_000;

/** 单次请求超时（AbortController）。 */
export const REQUEST_TIMEOUT_MS = 8_000;

/** User-Agent：GitHub API 要求带，不带会 403。 */
export const USER_AGENT = 'com-si-pet-update-check';

/** 状态文件名（放在 %APPDATA%\肆 下，和 activity-rules.json 同一层） */
export const UPDATE_STATE_FILE = 'update-check.json';

// ── 环境变量 ─────────────────────────────────────────────────────────────────

/** 检查模式：on（默认）/ off（完全不查）/ force（忽略 7 天限制，立刻查一次） */
export type UpdateCheckMode = 'on' | 'off' | 'force';

/**
 * 读 `PET_UPDATE_CHECK`。**每次调用都重新读**（和 pi-companion 的 activityRulesPath 一样），
 * 这样探针可以随时改环境变量，不用重新加载模块。不认识的值一律当 `on`。
 */
export function readUpdateCheckMode(): UpdateCheckMode {
  const raw = (process.env.PET_UPDATE_CHECK ?? '').trim().toLowerCase();
  if (raw === 'off') return 'off';
  if (raw === 'force') return 'force';
  return 'on';
}

/**
 * 桌宠数据目录 `%APPDATA%\肆`。
 * `PET_UPDATE_CHECK_ROOT` 优先（探针隔离用），其次 `PET_PI_ROOT`（和 pi 那套共用一个口子），
 * 都没有才落到真实的 APPDATA。
 */
export function updateCheckRoot(): string {
  const explicit = (process.env.PET_UPDATE_CHECK_ROOT ?? '').trim();
  if (explicit.length > 0) return explicit;
  const piRoot = (process.env.PET_PI_ROOT ?? '').trim();
  if (piRoot.length > 0) return piRoot;
  return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), '肆');
}

/** 状态文件绝对路径 */
export function updateStatePath(): string {
  return path.join(updateCheckRoot(), UPDATE_STATE_FILE);
}

// ── 版本比较（纯函数）─────────────────────────────────────────────────────────

/** 一个能解析的版本：`{ parts: [1,0,1], canonical: '1' }` */
interface ParsedVersion {
  parts: number[];
  /**
   * 掐掉末尾 0 段之后的规范写法（`1.0` 和 `1.0.0` 都是 `1`）。
   * 用它做"同一个版本"的相等判断，避免两件事同时发生：
   *   · `1.0.10` vs `1.0.9` 的字符串比较坑（那是误判"不相等"）
   *   · `1.0` vs `1.0.0` 的补零坑（那是误判"不相等"，会导致同一版本反复提示）
   */
  canonical: string;
}

/**
 * 解析版本号：允许一个前导 `v`/`V`，然后是 1~4 段用 `.` 分开的纯数字。
 *
 * 有意**只认这种形状**：
 *   · `1.0` → 能解析（缺的段按 0 补，比较时不会乱）
 *   · `abc` / `1.0.1-beta.1` / `v1.0.1-rc1` / `` / `1..0` / `最新版` → **解析不了，返回 undefined**
 * 预发布后缀（`-beta`）故意不认：`v1.0.1-beta` 和 `v1.0.0` 谁新是另一个问题，
 * 而主人要的是"有没有正式的新版本"，解析不了就不提示最保守。
 */
export function parseVersion(value: unknown): ParsedVersion | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return undefined;
  const withoutPrefix = /^[vV]/.test(trimmed) ? trimmed.slice(1) : trimmed;
  if (withoutPrefix.length === 0) return undefined;
  const segments = withoutPrefix.split('.');
  if (segments.length === 0 || segments.length > 4) return undefined;
  const parts: number[] = [];
  for (const segment of segments) {
    // 只接受纯数字（不认 +build / -rc / 前后空格 / 前导零以外的一切）
    if (!/^\d{1,9}$/.test(segment)) return undefined;
    parts.push(Number(segment));
  }
  return { parts, canonical: canonicalize(parts) };
}

/**
 * 规范化：**掐掉末尾的 0 段**，这样 `1.0` / `1.0.0` / `v1.0.0.0` 的规范写法都是 `1`。
 *
 * 为什么必须这么干：比较是按"补零对齐"算的（`1.0` 和 `1.0.0` 一样新），
 * 如果相等判断却用没掐零的字符串，就会冒出"比较说相等、去重说不等"的内讧 ——
 * 表现是同一个版本被反复提示。两处必须用同一把尺子。
 */
function canonicalize(parts: number[]): string {
  const trimmed = [...parts];
  while (trimmed.length > 1 && trimmed[trimmed.length - 1] === 0) trimmed.pop();
  return trimmed.join('.');
}

/**
 * 比较两个版本号（纯函数）。
 *
 * 返回：
 *   · `1`  —— a 比 b 新
 *   · `0`  —— 一样新（`1.0` 与 `1.0.0` 视为相同）
 *   · `-1` —— a 比 b 旧
 *   · `undefined` —— **任一边解析不了**。调用方必须把它当"不提示"处理，别猜。
 */
export function compareVersions(a: unknown, b: unknown): 1 | 0 | -1 | undefined {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return undefined;
  const length = Math.max(left.parts.length, right.parts.length);
  for (let index = 0; index < length; index += 1) {
    const l = left.parts[index] ?? 0;
    const r = right.parts[index] ?? 0;
    if (l > r) return 1;
    if (l < r) return -1;
  }
  return 0;
}

/** 两个版本是不是同一个（解析不了就按原字符串严格相等比，保守） */
export function isSameVersion(a: unknown, b: unknown): boolean {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left && right) return left.canonical === right.canonical;
  return typeof a === 'string' && typeof b === 'string' && a === b;
}

/**
 * 该不该因为 `latest` 提示主人。**这是"拿不准就不提示"的唯一出口**：
 *   · 主人在跑的版本解析不了 → 不提示
 *   · release 的 tag 解析不了 → 不提示
 *   · latest 不比 current 新 → 不提示
 *   · 同一个版本已经喊过了 → 不提示
 */
export function shouldNotify(current: unknown, latest: unknown, lastNotifiedVersion: unknown): boolean {
  const comparison = compareVersions(latest, current);
  if (comparison === undefined || comparison !== 1) return false;
  if (isSameVersion(latest, lastNotifiedVersion)) return false;
  return true;
}

// ── 状态文件（坏 JSON 一律当"从没查过"，绝不半信半疑地用一半）──────────────────

/** `%APPDATA%\肆\update-check.json` 的形状 */
export interface UpdateCheckState {
  /** 上次**成功**检查的时刻（ISO 字符串）；从没成功过就是 null */
  lastCheckedAt: string | null;
  /** 上次看到的远端版本（原样保存，比如 `v1.0.1`）；没看到过就是 null */
  lastSeenVersion: string | null;
  /** 上次**提示过**的版本；相同就不再提示 */
  lastNotifiedVersion: string | null;
}

/** 空状态：从没查过 */
export function emptyUpdateState(): UpdateCheckState {
  return { lastCheckedAt: null, lastSeenVersion: null, lastNotifiedVersion: null };
}

/** 只收非空字符串，其余（数字 / null / 空串 / 别的东西）一律 null */
function readStateString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 64 ? trimmed : null;
}

/** ISO 时间字符串；解析不了的当 null（宁可早查一次，也不要因为坏时间戳永远不查） */
function readStateTime(value: unknown): string | null {
  const text = readStateString(value);
  if (text === null) return null;
  return Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : null;
}

/**
 * 解析状态文件内容。**坏 JSON / 顶层不是对象 / 字段类型不对**一律退回空状态，
 * 绝不让一个坏文件把"该不该查"的判断带偏（最坏结果只是早查一次）。
 */
export function parseUpdateState(text: unknown): UpdateCheckState {
  if (typeof text !== 'string') return emptyUpdateState();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return emptyUpdateState();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return emptyUpdateState();
  const obj = parsed as Record<string, unknown>;
  return {
    lastCheckedAt: readStateTime(obj.lastCheckedAt),
    lastSeenVersion: readStateString(obj.lastSeenVersion),
    lastNotifiedVersion: readStateString(obj.lastNotifiedVersion),
  };
}

/** 读状态文件：不存在 / 读不动 / 坏 JSON → 空状态（静默，不抛） */
export function loadUpdateState(file = updateStatePath()): UpdateCheckState {
  try {
    return parseUpdateState(readFileSync(file, 'utf8'));
  } catch {
    return emptyUpdateState();
  }
}

/**
 * 写状态文件：目录不存在就建（`recursive: true`），原子性要求不高 ——
 * 这个文件最坏也只是"少查一次"，没必要动用 atomicWriteJson 那套。
 * 写失败返回 false（比如目录只读），由调用方决定要不要说一声。
 */
export async function saveUpdateState(state: UpdateCheckState, file = updateStatePath()): Promise<boolean> {
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 距上次成功检查够不够 7 天。`lastCheckedAt` 为空 / 坏掉 → 认为"该查"。
 * `now` 可注入 —— 探针不真等 7 天。
 */
export function isCheckDue(state: UpdateCheckState, now = Date.now()): boolean {
  if (!state.lastCheckedAt) return true;
  const last = Date.parse(state.lastCheckedAt);
  if (!Number.isFinite(last)) return true;
  // 时钟被往回拨（NTP 校时 / 主人改了系统时间）时 elapsed 是负数。
  // 只容忍 1 天以内：小回拨视为"就近"，仍然该查；
  // 回拨超过 1 天说明这台机器的时钟已经不可信，那就别每次启动都去问一遍 GitHub。
  const elapsed = now - last;
  if (elapsed < 0) return elapsed > -24 * 60 * 60 * 1000;
  return elapsed >= CHECK_INTERVAL_MS;
}

// ── 网络：一行 JSON，8 秒超时 ────────────────────────────────────────────────

/** 拿到远端版本号后的形状（**只留 tag**，其它字段一概不要） */
export interface LatestRelease {
  /** 原样的 tag，例如 `v1.0.1` */
  tag: string;
}

/**
 * 问一次 GitHub：最新的 tag 是什么。**任何异常都往上抛**，由 runUpdateCheck 统一吞掉 ——
 * 这样"失败路径"只有一处，不会出现半个成功。
 */
export async function fetchLatestRelease(options: {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
} = {}): Promise<LatestRelease> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // 调用方（app 退出 / 探针）还能从外面取消
  const onExternalAbort = (): void => controller.abort();
  options.signal?.addEventListener('abort', onExternalAbort, { once: true });

  try {
    const response = await fetchImpl(LATEST_RELEASE_API, {
      method: 'GET',
      headers: {
        // GitHub API 不带 User-Agent 会 403；Accept 固定成官方推荐的 JSON 媒体类型
        'User-Agent': USER_AGENT,
        Accept: 'application/vnd.github+json',
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`GitHub API responded ${response.status}`);
    const payload = (await response.json()) as unknown;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('GitHub API payload is not an object');
    }
    const tag = (payload as Record<string, unknown>).tag_name;
    if (typeof tag !== 'string' || tag.trim().length === 0 || tag.length > 64) {
      throw new Error('GitHub API payload has no usable tag_name');
    }
    return { tag: tag.trim() };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onExternalAbort);
  }
}

// ── 气泡文案（本地模板，绝不为了这个去调模型）────────────────────────────────

/** 2~3 个变体，随机挑一个，别每次都同一句 */
export const UPDATE_BUBBLE_TEMPLATES: readonly string[] = [
  '有新版本 {version} 了，去下载吧。',
  '肆看了一眼，{version} 都出来了，还在这儿用老的？',
  '更新到 {version} 了，闲了去换个新的嘛。',
];

/**
 * 拼气泡文案。模板 + 版本号，**纯字符串**，没有模型调用。
 * `random` 可注入（探针把三个变体都钉死）。
 */
export function buildUpdateBubble(version: string, random: () => number = Math.random): string {
  const templates = UPDATE_BUBBLE_TEMPLATES;
  const value = random();
  const index = Number.isFinite(value) ? Math.min(templates.length - 1, Math.max(0, Math.floor(value * templates.length))) : 0;
  const template = templates[index] ?? templates[0] as string;
  return template.replace('{version}', version);
}

// ── 一次完整检查（决策 + 落盘 + 提示，依赖全部注入）──────────────────────────

/** 一次检查的结局（给日志和探针看，不给 renderer） */
export interface UpdateCheckOutcome {
  /** 是不是真的发了网络请求 */
  checked: boolean;
  /** 有没有发现值得提示的新版本 */
  found: boolean;
  /** 远端看到了什么（原样）；没查到就是 null */
  latest: string | null;
  /** 为什么没查 / 没提示（只给日志，含英文短语，方便 grep） */
  reason: 'off' | 'disabled' | 'interval' | 'no-release' | 'not-newer' | 'already-notified' | 'error' | 'ok';
  /** 出错时的一句话（**只有错误信息**，不含 URL / 响应体） */
  error?: string;
}

/** runUpdateCheck 需要的外部能力（全部可注入 → 探针不用起 Electron、不用联网） */
export interface UpdateCheckDeps {
  /** 主人当前在跑的版本（main.ts 传 `app.getVersion()`） */
  currentVersion: string;
  /** 开关（读 cozeConfig.checkUpdates） */
  enabled: boolean;
  /** 挂在某个窗口上的提示（桌宠气泡）。**没窗口时要能安全地什么都不做并返回 false** */
  notifyBubble: (text: string) => boolean;
  /** 通知通话窗口"有新版本了" */
  notifyBanner?: (state: { latestVersion: string; url: string }) => void;
  /** 状态文件路径（默认 updateStatePath()） */
  stateFile?: string;
  /** 时钟（默认 Date.now） */
  now?: () => number;
  /** 随机源（默认 Math.random） */
  random?: () => number;
  /** 读状态（默认 loadUpdateState） */
  loadState?: (file: string) => UpdateCheckState;
  /** 写状态（默认 saveUpdateState） */
  saveState?: (state: UpdateCheckState, file: string) => Promise<boolean>;
  /** 抓 release（默认 fetchLatestRelease） */
  fetchLatest?: (options: { signal?: AbortSignal }) => Promise<LatestRelease>;
  /** 说一句（**只允许英文短语 + 错误信息**） */
  log?: (level: 'info' | 'warn', event: string, details?: Record<string, unknown>) => void;
  /** 外部取消（app 退出时） */
  signal?: AbortSignal;
  /** 覆盖环境变量读到的模式（探针用；不传就读 PET_UPDATE_CHECK） */
  mode?: UpdateCheckMode;
}

/**
 * 跑一次"检查更新"。**所有失败路径都在这里被吞掉**：网络失败 / JSON 坏 / 超时 / 状态文件
 * 写不动 —— 一律静默返回，不抛异常、不写坏状态（失败时我们**不动** lastCheckedAt，
 * 于是下次启动会再试；写坏的代价只是多一次请求，比"永远不再检查"轻得多）。
 *
 * 决策顺序（顺序本身就是优先级）：
 *   ① PET_UPDATE_CHECK=off → 连状态文件都不读
 *   ② 开关关掉 → 不查
 *   ③ 距上次成功检查 < 7 天 且 不是 force → 不查
 *   ④ 请求 + 解析（失败 → 静默）
 *   ⑤ 成功 → 记 lastCheckedAt + lastSeenVersion
 *   ⑥ latest 不比 current 新 / 解析不了 → 不提示
 *   ⑦ latest == lastNotifiedVersion → 不提示（同一个新版本只喊一次）
 *   ⑧ 提示：气泡 + 通话窗口那行 → 记 lastNotifiedVersion
 */
export async function runUpdateCheck(deps: UpdateCheckDeps): Promise<UpdateCheckOutcome> {
  const mode = deps.mode ?? readUpdateCheckMode();
  if (mode === 'off') return { checked: false, found: false, latest: null, reason: 'off' };
  if (!deps.enabled) return { checked: false, found: false, latest: null, reason: 'disabled' };

  const file = deps.stateFile ?? updateStatePath();
  const now = deps.now ?? (() => Date.now());
  const random = deps.random ?? Math.random;
  const loadState = deps.loadState ?? loadUpdateState;
  const saveState = deps.saveState ?? saveUpdateState;
  const fetchLatest = deps.fetchLatest ?? ((options) => fetchLatestRelease({ signal: options.signal }));

  const state = loadState(file);
  if (mode !== 'force' && !isCheckDue(state, now())) {
    return { checked: false, found: false, latest: null, reason: 'interval' };
  }

  let release: LatestRelease;
  try {
    release = await fetchLatest({ signal: deps.signal });
  } catch (error) {
    // 失败一律静默：不动 lastCheckedAt（下次启动会再试），也不抛
    const message = error instanceof Error ? error.message : String(error);
    deps.log?.('warn', 'update-check-failed', { message: message.slice(0, 200) });
    return { checked: true, found: false, latest: null, reason: 'error', error: message.slice(0, 200) };
  }

  // 成功后不管有没有新版本，都要记"查过了" —— 否则每启动一次就发一次请求
  const next: UpdateCheckState = {
    ...state,
    lastCheckedAt: new Date(now()).toISOString(),
    lastSeenVersion: release.tag,
  };

  if (!shouldNotify(deps.currentVersion, release.tag, state.lastNotifiedVersion)) {
    // 分清楚"不是新版本"和"喊过了"，日志里能一眼看出是哪种
    const comparison = compareVersions(release.tag, deps.currentVersion);
    const reason: UpdateCheckOutcome['reason'] = comparison === 1 ? 'already-notified' : 'not-newer';
    await saveState(next, file);
    deps.log?.('info', 'update-check-no-notify', { reason, latest: release.tag, current: deps.currentVersion });
    return { checked: true, found: false, latest: release.tag, reason };
  }

  // 先提示再落盘：落盘失败不能让主人这次白等（最坏下次重启再喊一次）
  const bubble = buildUpdateBubble(release.tag, random);
  const shown = deps.notifyBubble(bubble);
  deps.notifyBanner?.({ latestVersion: release.tag, url: RELEASES_PAGE_URL });
  await saveState({ ...next, lastNotifiedVersion: release.tag }, file);
  deps.log?.('info', 'update-available', { latest: release.tag, current: deps.currentVersion, bubbleShown: shown });

  return { checked: true, found: true, latest: release.tag, reason: 'ok' };
}
