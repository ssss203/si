/**
 * pi-companion.ts —— 「陪伴感知」：让肆低频瞥一眼主人在用电脑干什么，然后自己决定要不要搭话。
 *
 * ── 隐私不变式（这个文件的存在意义就是死守这四条）─────────────────────────────
 *   1. 【原文永不落盘】前台窗口的**原始标题**只在这个进程的内存里活几秒，然后被丢掉。
 *      不写 pi 会话、不写 logger、不写任何 json。进对话的只有下面的闭集标签。
 *   2. 【只有闭集标签】`ACTIVITY_TAGS` 是唯一允许出现的取值，没有任何自由文本通道。
 *   3. 【猜不出来就降级】关键词命中不了已知规则 → 浏览器落 `browsing`、其它落 `other`，
 *      **绝不把标题片段塞进标签**（那是泄露原文最常见的一条路）。
 *   4. 【默认关闭】`companionAwareness` 默认 false；关掉时连定时器都不建，
 *      一次窗口读取都不会发生（见 startCompanionSampler 的第一行 early return）。
 *
 * ── 注入机制：`pi.on('context', ...)`，依据是官方文档与类型定义里的原话 ────────────
 *   · dist/core/extensions/types.d.ts:644-654 对 ContextEvent 的注释：
 *       "Fired before each LLM call. Can modify messages.
 *        `messages` holds the conversation without system messages. The prompt and tool state
 *        belong to Pi: it restores them after the handler returns, so a handler cannot drop
 *        them and does not need to preserve them."
 *   · dist/core/extensions/runner.js:995-1002 emitContext 的实现：
 *       "Run the request-time transforms in two phases. `context` handlers see the conversation
 *        only and Pi restores the prompt and tool state after each" / `let currentMessages = structuredClone(messages);`
 *   · dist/core/sdk.js:266 `transformContext` → runner.emitContext(messages)
 *   · pi-agent-core/dist/agent-loop.js:260-268 streamAssistantResponse：
 *       `let messages = context.messages; if (config.transformContext) { messages = await config.transformContext(messages, signal); }`
 *       —— 改的是这个**局部变量**，从不写回 `context.messages`。
 *   结论：`context` 的返回值只影响**当前这一次 provider 请求**，是 request-local 的；
 *   会话文件（SessionManager 的 jsonl）里不会有它。
 *   ⚠️ 对比：`before_agent_start` 返回的 message 会变成 transcript 条目（plan-mode 例子里
 *   正是靠 `context` 把 `before_agent_start` 写进去的那条再过滤掉），所以**没有**用它。
 *
 * ── 反应怎么发生 ──────────────────────────────────────────────────────────────
 *   不新开通道：注入的提示词只写"参考"，肆想说话/想动就去调已有的 `say` / `play_animation`
 *   工具 —— 于是自动受 pi-actions.ts 那套节流（每轮 3 个 / 每小时 6 个）约束。
 *
 * ⚠️ 老规矩（和 pi-tools.ts / pi-actions.ts 一样）：pi 是纯 ESM，值导入必须动态 import()，
 * 静态导入只留 `import type`（编译期擦除）。
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CompanionActivity, CompanionTag } from '../shared/contracts';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

// ── 闭集标签 ─────────────────────────────────────────────────────────────────

/**
 * 允许进对话的全部标签（闭集）。加新标签必须同时改这里和 shared/contracts.ts 的
 * CompanionTag，两处不一致会直接编译不过 —— 这是有意的。
 */
export const ACTIVITY_TAGS: readonly CompanionTag[] = [
  'coding',
  'working-with-ai',
  'reading-docs',
  'searching',
  'browsing',
  'watching-video',
  'listening-music',
  'chatting',
  'meeting',
  'gaming',
  'terminal',
  'designing',
  'idle',
  'other',
];

/** O(1) 白名单查询 */
const TAG_SET = new Set<string>(ACTIVITY_TAGS);

/** 标签是不是闭集里的（探针与防御性代码共用） */
export function isCompanionTag(value: unknown): value is CompanionTag {
  return typeof value === 'string' && TAG_SET.has(value);
}

// ── 规则表（可被用户的 activity-rules.json 覆盖/追加）─────────────────────────

/**
 * 一条分类规则：`keywords` 里任一词命中（窗口标题或进程名，大小写不敏感）就落 `tag`。
 * 规则的顺序有意义 —— 命中数相同时，靠前的赢。
 */
export interface ActivityRule {
  tag: CompanionTag;
  keywords: string[];
}

/** 规则文件 / 内置默认规则的整体形状 */
export interface ActivityRules {
  /** 关键词规则（用户文件里的在前，先匹配） */
  rules: ActivityRule[];
  /** 关键词一个都没命中时，按进程名兜底 */
  processTags: Record<string, CompanionTag>;
  /** 进程名也没兜住时的最粗标签 */
  defaultTag: CompanionTag;
}

/**
 * 内置默认规则。⚠️ 这里的词都会跟着代码进 git，**不要写主人的私人项目名**。
 * 注意：进程名不在这里，全部收在 processTags —— 见下面 classifyActivity 的"不猜"原则。
 */
export const DEFAULT_ACTIVITY_RULES: ActivityRules = {
  rules: [
    // 终端：顺序放在 coding 前面 —— 一个终端窗口的标题常常就是项目名，
    // 而"这是个终端"比"他在写代码"更确定（拿不准时选更保守的那个说法）。
    { tag: 'terminal', keywords: ['powershell', 'cmd.exe', 'windows terminal', 'git bash', 'wsl', '命令提示符'] },
    { tag: 'working-with-ai', keywords: ['chatgpt', 'claude', 'copilot', 'deepseek', 'kimi', '文心一言', '通义千问'] },
    { tag: 'searching', keywords: ['google search', '百度搜索', 'bing search', '搜索 - ', 'search results'] },
    // 「播放」这个词故意不收：它在"Playing: foo.ts"这种标题里也会命中，
    // 会把写代码误判成看视频。宁可漏判（落到 coding/other），不要误判。
    { tag: 'watching-video', keywords: ['youtube', 'bilibili', '哔哩哔哩', 'netflix', '爱奇艺', '腾讯视频', '优酷'] },
    { tag: 'listening-music', keywords: ['spotify', 'music', '网易云音乐', 'qq音乐', '音乐'] },
    { tag: 'meeting', keywords: ['zoom meeting', 'google meet', '腾讯会议', '飞书会议', 'teams meeting', '会议'] },
    { tag: 'chatting', keywords: ['微信', 'wechat', 'qq', 'telegram', 'discord', 'slack', '飞书', '钉钉'] },
    { tag: 'gaming', keywords: ['steam', '游戏', 'game', '原神', '英雄联盟', 'minecraft'] },
    { tag: 'designing', keywords: ['photoshop', 'illustrator', 'figma', 'blender', 'sketch', 'axure', 'canva'] },
    // 'the docs' 是故意收的（而不是 `readthedocs`）：真实标题里几乎都写作
    // "Read the Docs" / "… — the docs"，带空格的写法。探针里就是这么钉的。
    { tag: 'reading-docs', keywords: ['documentation', '官方文档', 'devdocs', 'mdn', '手册', 'the docs', 'api reference'] },
    // coding 垫在最后：关键词最泛（`main.ts` 这种），泛的必须排在窄的后面。
    // ⚠️ 这里**故意不收 `npm run`**：一个写着 `npm run check` 的 cmd 窗口会因此被
    // 判成 coding，但它明明是个终端。更保守的说法是 terminal —— 探针里就是这么钉的。
    { tag: 'coding', keywords: ['visual studio code', 'vscode', 'cursor', 'webstorm', 'pycharm', 'intellij', 'sublime text', 'notepad++', 'main.ts', 'index.ts', 'package.json', 'git diff'] },
  ],
  processTags: {
    // 浏览器：标题里没命中关键词就落 browsing（"不猜"原则允许的最粗说法）
    chrome: 'browsing',
    msedge: 'browsing',
    firefox: 'browsing',
    brave: 'browsing',
    opera: 'browsing',
    iexplore: 'browsing',
    // 编辑器 / IDE
    code: 'coding',
    'code - insiders': 'coding',
    cursor: 'coding',
    devenv: 'coding',
    webstorm: 'coding',
    pycharm: 'coding',
    goland: 'coding',
    idea64: 'coding',
    sublime_text: 'coding',
    notepad: 'coding',
    notepadpp: 'coding',
    // 终端
    windowsterminal: 'terminal',
    powershell: 'terminal',
    pwsh: 'terminal',
    cmd: 'terminal',
    conhost: 'terminal',
    wt: 'terminal',
    mintty: 'terminal',
    bash: 'terminal',
    // 聊天
    wechat: 'chatting',
    weixin: 'chatting',
    qq: 'chatting',
    telegram: 'chatting',
    discord: 'chatting',
    slack: 'chatting',
    dingtalk: 'chatting',
    feishu: 'chatting',
    lark: 'chatting',
    // 音乐
    spotify: 'listening-music',
    cloudmusic: 'listening-music',
    qqmusic: 'listening-music',
    aimp: 'listening-music',
    foobar2000: 'listening-music',
    // 会议 / 游戏 / 设计
    zoom: 'meeting',
    teams: 'meeting',
    wemeetapp: 'meeting',
    steam: 'gaming',
    'steamwebhelper': 'gaming',
    photoshop: 'designing',
    illustrator: 'designing',
    figma: 'designing',
    blender: 'designing',
    // 视频播放器（本地）
    potplayermini64: 'watching-video',
    'vlc': 'watching-video',
    // AI 客户端
    claude: 'working-with-ai',
    chatgpt: 'working-with-ai',
    ollama: 'working-with-ai',
    // 系统外壳：真的什么都没在看
    explorer: 'idle',
    lockapp: 'idle',
    logonui: 'idle',
    'applicationframehost': 'idle',
    searchapp: 'idle',
    shellexperiencehost: 'idle',
    startmenuexperiencehost: 'idle',
  },
  defaultTag: 'other',
};

/** 规则文件路径：%APPDATA%\肆\activity-rules.json（petRoot 可用 PET_PI_ROOT 覆盖，探针用） */
export function activityRulesPath(): string {
  const override = (process.env.PET_PI_ROOT ?? '').trim();
  const root = override.length > 0
    ? override
    : path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), '肆');
  return path.join(root, 'activity-rules.json');
}

/**
 * 写一份默认规则给主人改（首次运行）。
 *
 * 只在**文件不存在**时写：主人删掉的规则不能被我们偷偷加回来。
 * 失败不抛（目录不可写时照旧用内置默认规则跑）。
 */
export function ensureActivityRulesFile(file = activityRulesPath()): boolean {
  try {
    if (existsSync(file)) return false;
    writeFileSync(file, `${JSON.stringify(DEFAULT_ACTIVITY_RULES, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

// ── 规则文件的解析（坏文件一律退回内置默认，绝不半信半疑地用一半）───────────────

/** 规则文件的磁盘形状（全是 unknown，逐个校验） */
interface RawRulesFile {
  rules?: unknown;
  processTags?: unknown;
  defaultTag?: unknown;
}

/** 只留下闭集里的标签；其余（含拼错的、自由文本）直接丢掉 */
function parseRuleList(value: unknown): ActivityRule[] {
  if (!Array.isArray(value)) return [];
  const parsed: ActivityRule[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const rule = item as { tag?: unknown; keywords?: unknown };
    if (!isCompanionTag(rule.tag)) continue;
    if (!Array.isArray(rule.keywords)) continue;
    const keywords = rule.keywords
      .filter((keyword): keyword is string => typeof keyword === 'string' && keyword.trim().length > 0)
      .map((keyword) => keyword.trim());
    if (keywords.length === 0) continue;
    parsed.push({ tag: rule.tag, keywords });
  }
  return parsed;
}

function parseProcessTags(value: unknown): Record<string, CompanionTag> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const parsed: Record<string, CompanionTag> = {};
  for (const [key, tag] of Object.entries(value as Record<string, unknown>)) {
    if (!isCompanionTag(tag)) continue;
    const name = key.trim().toLowerCase();
    if (name.length === 0) continue;
    parsed[name] = tag;
  }
  return parsed;
}

/**
 * 合并用户规则与内置默认规则。
 *
 * 用户规则**排在前面**（同分时先命中用户那条），所以"自定义规则能覆盖默认"。
 * 这是覆盖而不是替换：用户只写 `[{"tag":"listening-music","keywords":["foobar"]}]`
 * 时，内置那一堆规则照旧生效。
 */
export function mergeActivityRules(user: Partial<ActivityRules> | undefined): ActivityRules {
  const userRules = parseRuleList(user?.rules);
  const userProcessTags = parseProcessTags(user?.processTags);
  const defaultTag = isCompanionTag(user?.defaultTag) ? user.defaultTag : DEFAULT_ACTIVITY_RULES.defaultTag;
  return {
    rules: [...userRules, ...DEFAULT_ACTIVITY_RULES.rules],
    processTags: { ...DEFAULT_ACTIVITY_RULES.processTags, ...userProcessTags },
    defaultTag,
  };
}

/**
 * 读规则文件。文件不存在 / 坏 JSON / 形状不对 → 全部静默退回内置默认。
 * 这里 catch 得这么宽是有意的：规则是"锦上添花"，任何解析问题都不该影响采样。
 */
export function loadActivityRules(file = activityRulesPath()): ActivityRules {
  try {
    const raw = readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as RawRulesFile;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return mergeActivityRules(undefined);
    }
    return mergeActivityRules({
      rules: parseRuleList(parsed.rules),
      processTags: parseProcessTags(parsed.processTags),
      defaultTag: isCompanionTag(parsed.defaultTag) ? parsed.defaultTag : undefined,
    });
  } catch {
    return mergeActivityRules(undefined);
  }
}

// ── 分类器（纯函数，不联网、不调模型、不落盘）───────────────────────────────

/** 一次前台窗口读取的原始结果。⚠️ 只该活在内存里，别传给任何持久化层。 */
export interface ForegroundWindow {
  /** 进程名，例如 chrome / Code / WindowsTerminal */
  processName: string;
  /** 窗口标题原文。**这是敏感数据**，只在内存里过一遍分类器。 */
  title: string;
}

/** 分类结果。注意这里没有 `title` 字段 —— 标题到此为止。 */
export interface ActivityClassification {
  tag: CompanionTag;
  /** 是不是真的命中了规则（false = 降级到默认标签） */
  matched: boolean;
}

/** 进程名归一：小写 + 去掉 .exe（PowerShell 有时给 chrome，有时给 chrome.exe） */
function normalizeProcessName(processName: string): string {
  return processName.trim().toLowerCase().replace(/\.exe$/, '');
}

/**
 * 分类：`{ processName, title }` + 规则 → 标签。
 *
 * 纯函数 —— 没有 IO、没有随机、没有时间。探针可以直接喂样本断言。
 *
 * 判定顺序：
 *   1. 关键词规则（用户规则优先，同分取靠前）。标题与进程名拼成一串做**不区分大小写**的
 *      `includes` —— 故意不用正则：主人的标题里有 `*` `(` 这些字符时正则可能抛错，
 *      而"采样因为标题长得奇怪就崩了"是不允许的。
 *   2. 进程名兜底（processTags）。
 *   3. 最粗的 defaultTag（内置是 `other`；浏览器在 processTags 里就落 `browsing`）。
 */
export function classifyActivity(window: ForegroundWindow, rules: ActivityRules): ActivityClassification {
  const processName = normalizeProcessName(window.processName ?? '');
  // 标题可能超长（有些窗口标题能到几 KB）—— 截断到 512 字符再匹配：
  // 关键词都很短，512 足够命中；同时避免为一个恶意超长标题做无谓的扫描。
  const title = typeof window.title === 'string' ? window.title.slice(0, 512) : '';
  const haystack = `${title}\n${processName}`.toLowerCase();

  let best: ActivityClassification | undefined;
  let bestScore = 0;
  for (const rule of rules.rules) {
    let score = 0;
    for (const keyword of rule.keywords) {
      if (haystack.includes(keyword.toLowerCase())) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      best = { tag: rule.tag, matched: true };
    }
  }
  if (best) return best;

  const byProcess = rules.processTags[processName];
  if (byProcess !== undefined) return { tag: byProcess, matched: true };

  return { tag: rules.defaultTag, matched: false };
}

// ── 采样：读一次前台窗口（Windows；macOS 暂不实现）──────────────────────────

/** PowerShell 脚本绝对路径。webpack 打包后 __dirname 是 .webpack/main，所以先试项目布局。 */
function foregroundScriptPath(): string {
  const candidates = [
    path.resolve(process.cwd(), 'tools', 'foreground-window.ps1'),
    path.resolve(__dirname, '..', '..', 'tools', 'foreground-window.ps1'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0] as string;
}

/**
 * 读一次前台窗口。失败（超时 / 没有 PowerShell / 不是 Windows / 脚本缺失）一律返回
 * undefined —— 调用方静默跳过这次采样，绝不因为读不到窗口而报错。
 *
 * 不新增原生依赖：就一次 child_process，跑一个只做 GetForegroundWindow 的 ps1。
 * macOS：**暂不实现**（要 AppleScript + 辅助功能权限，是另一件事），这里返回 undefined，
 * 上层逻辑照常跑，只是永远采不到样本。
 */
export async function readForegroundWindow(timeoutMs = 1500): Promise<ForegroundWindow | undefined> {
  if (process.platform !== 'win32') return undefined;
  const script = foregroundScriptPath();
  if (!existsSync(script)) return undefined;

  return new Promise<ForegroundWindow | undefined>((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
      { timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 },
      (error, stdout) => {
        if (error) { resolve(undefined); return; }
        // 脚本只输出两行：第一行进程名，第二行标题。标题里可以有换行，所以用 split 取「第一行 + 其余」。
        const text = String(stdout ?? '').replace(/^\uFEFF/, '');
        const newline = text.indexOf('\n');
        if (newline < 0) { resolve(undefined); return; }
        const processName = text.slice(0, newline).trim();
        const title = text.slice(newline + 1).replace(/\r?\n$/, '');
        if (processName.length === 0) { resolve(undefined); return; }
        resolve({ processName, title });
      },
    );
  });
}

// ── 内存里的活动历史（只存标签 + 时间）─────────────────────────────────────

/**
 * 快照：**只含标签与时间戳**，没有标题字段。
 * 这是主进程 → dashboard 传输的唯一形状，所以"渲染层永远拿不到原文"是结构上成立的。
 */
export interface CompanionSample extends CompanionActivity {
  /** 判定这条标签时用的进程名 —— 用于去重，不上 IPC */
  processName: string;
}

/** dashboard 最多能看到多少条 */
export const COMPANION_HISTORY_LIMIT = 10;

/** 标签的保鲜期：超过这个时长的活动就不该再提了 */
export const COMPANION_FRESH_MS = 10 * 60_000;

/**
 * 模块级历史。**只活在内存里** —— 重启即忘，不写任何文件。
 * 只存标签 + 时间；`processName` 跟着存是为了去重（同一个应用连续采样算同一条），
 * 它同样只在内存里，不上 IPC、不落盘。
 */
let activityHistory: CompanionSample[] = [];

/** 记一条（同标签连续采样合并成一条：主人开着一小时 Chrome 不该刷满 10 条） */
export function recordActivity(sample: CompanionSample): CompanionSample[] {
  const last = activityHistory[activityHistory.length - 1];
  if (last && last.tag === sample.tag && last.processName === sample.processName) {
    activityHistory[activityHistory.length - 1] = sample;
  } else {
    activityHistory.push(sample);
  }
  if (activityHistory.length > COMPANION_HISTORY_LIMIT) {
    activityHistory = activityHistory.slice(-COMPANION_HISTORY_LIMIT);
  }
  return activityHistory;
}

/** 最近的活动（旧 → 新） */
export function getActivityHistory(): readonly CompanionSample[] {
  return activityHistory;
}

/** 清空（dashboard 的「清空」按钮） */
export function clearActivityHistory(): void {
  activityHistory = [];
}

/** 最新一条（注入用）；历史为空返回 undefined */
export function latestActivity(): CompanionSample | undefined {
  return activityHistory[activityHistory.length - 1];
}

/**
 * 距现在多久了，以及够不够新鲜。
 * `now` 可注入 —— 探针不真等 10 分钟，直接喂时间戳。
 */
export function activityAge(sample: CompanionSample, now = Date.now()): { minutes: number; fresh: boolean } {
  const minutes = Math.max(0, Math.floor((now - sample.at) / 60_000));
  return { minutes, fresh: now - sample.at < COMPANION_FRESH_MS };
}

// ── 采样间隔（低频 + 随机抖动）──────────────────────────────────────────────

/** 采样间隔下限 20 分钟 */
export const COMPANION_MIN_INTERVAL_MS = 20 * 60_000;
/** 采样间隔上限 45 分钟 */
export const COMPANION_MAX_INTERVAL_MS = 45 * 60_000;

/**
 * 下一次该等多久：在 [20, 45] 分钟之间（含两端）。
 * `random` 可注入 —— 探针喂 0 / 1 / 0.5 就能把边界钉死，不用真等。
 */
export function nextSampleDelay(random: () => number = Math.random): number {
  const span = COMPANION_MAX_INTERVAL_MS - COMPANION_MIN_INTERVAL_MS;
  const value = random();
  const clamped = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
  return COMPANION_MIN_INTERVAL_MS + Math.round(clamped * span);
}

/** 采样器需要的外部能力（全部可注入，探针不必起 Electron / 真读窗口） */
export interface CompanionSamplerOptions {
  /** 开关（读 cozeConfig.companionAwareness） */
  enabled: boolean;
  /** 读一次前台窗口 */
  sample: () => Promise<ForegroundWindow | undefined>;
  /** 分类规则（每次采样时重新读，主人改文件不用重启） */
  rules: () => ActivityRules;
  /** 记一条 */
  record: (sample: CompanionSample) => void;
  /** 定时器（默认 setTimeout）；探针注入一个什么都不做的假实现 */
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  /** 取消定时器 */
  cancel?: (handle: ReturnType<typeof setTimeout>) => void;
  /** 随机源 */
  random?: () => number;
  /** 出问题时说一句（**只允许标签/错误信息，禁止标题**） */
  onError?: (message: string) => void;
  now?: () => number;
}

/**
 * 启一次采样循环，返回 stop()。
 *
 * 三条硬规矩：
 *   · `enabled === false` → **立刻返回，连定时器都不建**（不起定时器 = 不会读窗口）。
 *   · 间隔是 [20, 45] 分钟之间的随机值（`nextSampleDelay`），不是固定心跳。
 *   · 每次采样只读一次前台窗口；读不到就静默跳过，循环继续等下一个长间隔。
 */
export function startCompanionSampler(options: CompanionSamplerOptions): () => void {
  if (!options.enabled) return () => { };

  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancel = options.cancel ?? ((handle) => clearTimeout(handle));
  const random = options.random ?? Math.random;
  const now = options.now ?? (() => Date.now());

  let handle: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const tick = async (): Promise<void> => {
    handle = undefined;
    if (stopped) return;
    try {
      const window = await options.sample();
      // 读不到窗口（超时 / 非 Windows / 脚本缺失）→ 静默跳过这一轮，不报错、不记样本
      if (window) {
        const { tag } = classifyActivity(window, options.rules());
        options.record({ tag, at: now(), processName: normalizeProcessName(window.processName) });
      }
    } catch (error) {
      // 采样失败永远不该影响桌宠：说一句然后继续。（这里只允许出现 error.message）
      options.onError?.(error instanceof Error ? error.message : String(error));
    } finally {
      if (!stopped) handle = schedule(() => { void tick(); }, nextSampleDelay(random));
    }
  };

  // 启动时**不立刻采样**：装一个 20~45 分钟后的定时器就行。
  // 这样"刚打开桌宠就去看主人在干嘛"这件事根本不会发生。
  handle = schedule(() => { void tick(); }, nextSampleDelay(random));

  return () => {
    stopped = true;
    if (handle !== undefined) cancel(handle);
    handle = undefined;
  };
}

// ── 注入：pi.on('context', ...) ─────────────────────────────────────────────

/** 注入进这一轮请求的消息（形状照 dist/core/messages.d.ts 的 CustomMessage） */
interface ContextHintMessage {
  role: 'custom';
  customType: string;
  content: string;
  display: boolean;
  timestamp: number;
}

/** 注入用的 customType 前缀，方便一眼看出这是谁塞的 */
export const COMPANION_CUSTOM_TYPE = 'companion-awareness';

/**
 * 把最新活动拼成一行提示词。**只在标签新鲜时返回**，过期就别提了
 * （主人二十分钟前在看视频，现在在开会 —— 提旧的比不提更糟）。
 *
 * 目标 ≤ 25 token：`活动参考：主人正在 coding（已 25 分钟）。`
 * `text` 完全由闭集标签 + 整数分钟数拼成，**没有任何来自标题的字符**。
 */
export function buildActivityHint(sample: CompanionSample, now = Date.now()): string | undefined {
  const { minutes, fresh } = activityAge(sample, now);
  if (!fresh) return undefined;
  return `活动参考：主人正在 ${sample.tag}（已 ${minutes} 分钟）。`;
}

export function createCompanionExtension(options: {
  /** 拿最新一条活动（历史为空 → undefined） */
  getLatest: () => CompanionSample | undefined;
  /** 当前时间（探针可注入） */
  now?: () => number;
}): (pi: ExtensionAPI) => Promise<void> {
  const now = options.now ?? (() => Date.now());
  return async (pi: ExtensionAPI): Promise<void> => {
    // 机制依据见文件头。要点：返回值只影响当前这次 provider 请求，不落盘、
    // 不动 system prompt（pi 在 handler 返回后会把 prompt / 工具状态还原回去）。
    pi.on('context', (event) => {
      const sample = options.getLatest();
      if (!sample) return;
      const hint = buildActivityHint(sample, now());
      if (hint === undefined) return;
      // 每次都是新数组：不去改 pi 传进来的那份（虽然它已经是 structuredClone，
      // 但"只读入参"是这个仓库的既有习惯）。
      const message: ContextHintMessage = {
        role: 'custom',
        customType: COMPANION_CUSTOM_TYPE,
        content: hint,
        display: false,
        timestamp: now(),
      };
      return { messages: [...event.messages, message as never] };
    });
  };
}
