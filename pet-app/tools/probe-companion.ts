/**
 * probe-companion.ts —— 「陪伴感知」的零成本自测（不调 API、不起 Electron、不碰真实 %APPDATA%\肆）。
 *
 * 它验的：
 *   ① 分类器：十几组 {processName, title} 样本 → 期望标签；中文 / 空标题 / 超长标题 /
 *      奇怪字符 / 浏览器看视频 / 看文档 / 搜索 / 音乐播放器 / 聊天软件 / 编辑器 / 终端 / 游戏
 *   ② **隐私**：把标题设成 SECRET-MARKER-12345，分类结果与所有落盘文件里都不含这个 marker
 *   ③ 规则文件：自定义规则覆盖默认 / 坏 JSON 退回默认 / 未知应用降级到 other
 *   ④ 开关关闭时采样函数**不被调用**（计数桩）
 *   ⑤ 活动历史：只存标签 + 时间、上限 10 条、清空可用
 *   ⑥ 采样间隔落在 [20, 45] 分钟（随机源注入，不真等）
 *   ⑦ 注入：pi.on('context') 只在标签新鲜时返回注入消息，且内容里没有任何标题字符
 *
 * 隔离方式：PET_PI_ROOT 指到临时目录，所以 activity-rules.json 写在临时目录里，
 * 真实 %APPDATA%\肆\activity-rules.json 一个字节都不会被这个探针碰到。
 *
 * 运行：
 *   cd F:\ss_yong\si\pet-si\pet-app
 *   npx tsx tools/probe-companion.ts
 */
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

// ⚠️ tsx 把探针编译成 CJS，所以这里**不能**用顶层 await，也不能靠 import.meta。
// 环境变量必须在 src 模块被求值之前设好（pi-companion 的 activityRulesPath() 是调用时读的），
// 所以下面全部放在 main() 里，用动态 import 拿模块。
//
// eslint 那行 require：CJS 下 require 是现成的，用它加载 TS 源文件（和 probe-actions 同一套路）。
declare const require: (id: string) => unknown;

// ── 断言小工具 ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` —— ${detail}` : ''}`);
}

async function main(): Promise<void> {
  /** 必须**在任何 src 模块被求值之前**设好：规则文件要落在临时目录，不能碰真实 %APPDATA%\肆 */
  const PET_ROOT = await mkdtemp(path.join(os.tmpdir(), 'si-probe-companion-'));
  process.env.PET_PI_ROOT = PET_ROOT;

  const companion = require('../src/main/pi-companion.ts') as typeof import('../src/main/pi-companion.ts');
  const {
    ACTIVITY_TAGS,
    COMPANION_HISTORY_LIMIT,
    COMPANION_MAX_INTERVAL_MS,
    COMPANION_MIN_INTERVAL_MS,
    DEFAULT_ACTIVITY_RULES,
    activityAge,
    activityRulesPath,
    buildActivityHint,
    classifyActivity,
    clearActivityHistory,
    createCompanionExtension,
    ensureActivityRulesFile,
    getActivityHistory,
    isCompanionTag,
    latestActivity,
    loadActivityRules,
    nextSampleDelay,
    recordActivity,
    startCompanionSampler,
  } = companion;

  /** 分类器：断言标签 + 断言结果里不带标题片段 */
  function checkTag(label: string, window: { processName: string; title: string }, expected: string, rules = loadActivityRules()): void {
    const result = classifyActivity(window, rules);
    const ok = result.tag === expected;
    check(`分类 ${label} → ${expected}`, ok, ok ? '' : `实际得到 ${result.tag}（matched=${result.matched}）`);
  }

  // ── ① + ② 分类器样本 ───────────────────────────────────────────────────────

  const MARKER = 'SECRET-MARKER-12345';

  const SAMPLES: Array<{ label: string; window: { processName: string; title: string }; expected: string }> = [
    // 编辑器 / IDE
    { label: 'VSCode 打开 main.ts', window: { processName: 'Code', title: 'main.ts - si-pet - Visual Studio Code' }, expected: 'coding' },
    { label: 'VSCode 中文标题', window: { processName: 'Code', title: '肆的通话窗口 - 我的项目 - Visual Studio Code' }, expected: 'coding' },
    // 终端
    { label: 'Windows Terminal', window: { processName: 'WindowsTerminal', title: '肆@DESKTOP: ~/pet-app' }, expected: 'terminal' },
    { label: 'cmd 标题带 npm run', window: { processName: 'cmd', title: 'npm run check' }, expected: 'terminal' },
    // 浏览器：看视频 / 看文档 / 搜索
    { label: 'Chrome 看 B 站', window: { processName: 'chrome', title: '【合集】某个视频_哔哩哔哩_bilibili' }, expected: 'watching-video' },
    { label: 'Chrome 看文档', window: { processName: 'chrome', title: 'SessionManager | Read the Docs' }, expected: 'reading-docs' },
    { label: 'Chrome 搜索', window: { processName: 'chrome', title: 'electron ipcMain handle - Google Search' }, expected: 'searching' },
    { label: 'Chrome 中文搜索', window: { processName: 'chrome', title: 'electron 主进程 - 百度搜索' }, expected: 'searching' },
    { label: 'Chrome 普通页面 → browsing', window: { processName: 'chrome', title: '某个博客 - 我的收藏' }, expected: 'browsing' },
    { label: 'Edge 无标题 → browsing', window: { processName: 'msedge', title: '' }, expected: 'browsing' },
    // 音乐 / 聊天
    { label: '网易云音乐', window: { processName: 'cloudmusic', title: '网易云音乐' }, expected: 'listening-music' },
    { label: 'QQ 音乐（音乐 vs 聊天抢命中）', window: { processName: 'QQMusic', title: 'QQ音乐' }, expected: 'listening-music' },
    { label: '微信', window: { processName: 'WeChat', title: '微信' }, expected: 'chatting' },
    // 会议 / AI / 游戏 / 设计
    { label: '腾讯会议', window: { processName: 'wemeetapp', title: '腾讯会议' }, expected: 'meeting' },
    { label: 'ChatGPT 窗口', window: { processName: 'chrome', title: 'ChatGPT' }, expected: 'working-with-ai' },
    { label: 'Steam 游戏', window: { processName: 'steam', title: 'Steam' }, expected: 'gaming' },
    { label: 'Figma 设计', window: { processName: 'figma', title: '设计稿 - Figma' }, expected: 'designing' },
    // 系统外壳 → idle
    { label: '桌面 / 资源管理器', window: { processName: 'explorer', title: 'Program Manager' }, expected: 'idle' },
    // 未知应用 → other（"不猜"原则）
    { label: '完全未知的进程', window: { processName: 'totally-unknown-app', title: '某个看不懂的窗口' }, expected: 'other' },
    // 边界：空标题 / 空进程名 / 超长标题 / 奇怪字符
    { label: '空标题 + 未知进程', window: { processName: 'zzz', title: '' }, expected: 'other' },
    { label: '空标题 + 已知进程（Code）', window: { processName: 'Code', title: '' }, expected: 'coding' },
    { label: '空白标题 + 已知进程', window: { processName: 'explorer', title: '   \t  ' }, expected: 'idle' },
    { label: '超长标题（4K 字符）', window: { processName: 'chrome', title: `标题${'很'.repeat(4000)}` }, expected: 'browsing' },
    { label: '奇怪字符 / 正则元字符', window: { processName: 'unknown(1)[a]', title: '(((([[[[ **** ??? \\\\ ' }, expected: 'other' },
    { label: '奇怪字符 + 已知进程', window: { processName: 'code', title: '(((([[[[' }, expected: 'coding' },
    { label: 'emoji 标题', window: { processName: 'chrome', title: '🎉🎉 首页 - 我的浏览器' }, expected: 'browsing' },
    { label: '进程名带 .exe 后缀', window: { processName: 'chrome.exe', title: '某页面' }, expected: 'browsing' },
    // 隐私样本：标题里塞 marker，期望仍然是正常分类，且不能被带出去
    { label: 'marker 标题（应该是 browsing）', window: { processName: 'chrome', title: `${MARKER} 一些不希望被记下来的内容` }, expected: 'browsing' },
    { label: 'marker 标题（应该是 coding）', window: { processName: 'Code', title: `${MARKER} - Visual Studio Code` }, expected: 'coding' },
  ];

  console.log(`\n=== ① 分类器（${SAMPLES.length} 组样本）===\n`);
  for (const sample of SAMPLES) checkTag(sample.label, sample.window, sample.expected);

  console.log('\n=== ② 标签闭集 & 不含标题片段 ===\n');

  {
    const rules = loadActivityRules();
    let allInSet = true;
    let allNoTitleLeak = true;
    for (const sample of SAMPLES) {
      const result = classifyActivity(sample.window, rules);
      if (!isCompanionTag(result.tag)) allInSet = false;
      // 分类结果序列化之后不能出现标题的任何 ≥8 字符片段
      const serialized = JSON.stringify(result);
      const title = sample.window.title;
      if (title.length >= 8) {
        for (let i = 0; i + 8 <= title.length; i += 1) {
          if (serialized.includes(title.slice(i, i + 8))) { allNoTitleLeak = false; break; }
        }
      }
      if (serialized.includes(MARKER)) allNoTitleLeak = false;
      // 结果里也不应该有 title / processName 字段
      if (serialized.includes('"title"') || serialized.includes('"processName"')) allNoTitleLeak = false;
    }
    check('所有分类结果都是闭集标签', allInSet);
    check('分类结果里不含任何标题片段 / marker / 字段名', allNoTitleLeak);
    check('ACTIVITY_TAGS 不含重复项', new Set(ACTIVITY_TAGS).size === ACTIVITY_TAGS.length, `${ACTIVITY_TAGS.length} 个标签`);
    check('ACTIVITY_TAGS 恰好是约定的 14 个', ACTIVITY_TAGS.length === 14, ACTIVITY_TAGS.join(' · '));
  }


  // ── ③ 规则文件 ───────────────────────────────────────────────────────────────

  console.log('\n=== ③ 规则文件 ===\n');

  const rulesFile = activityRulesPath();
  check('规则文件路径落在临时根目录里（没污染真实 %APPDATA%）', rulesFile.startsWith(PET_ROOT), rulesFile);

  {
    check('确保 activity-rules.json 不存在', await stat(rulesFile).then(() => false).catch(() => true));
    const wrote = ensureActivityRulesFile(rulesFile);
    check('首次运行写出一份默认规则', wrote && await stat(rulesFile).then(() => true).catch(() => false));

    const written = JSON.parse(await readFile(rulesFile, 'utf8')) as unknown;
    check('写出的文件内容 = 内置默认规则',
      JSON.stringify(written) === JSON.stringify(DEFAULT_ACTIVITY_RULES));
    check('写出的文件里不含任何窗口标题 / marker',
      !JSON.stringify(written).includes(MARKER) && !JSON.stringify(written).includes('"title"'));

    // 第二次调用不能再写（主人删掉的规则不能被偷偷加回来）
    check('文件已存在时不再覆盖', ensureActivityRulesFile(rulesFile) === false);
  }

  // 自定义规则能覆盖默认：让 obsidian 归到 reading-docs
  {
    await writeFile(rulesFile, JSON.stringify({
      rules: [{ tag: 'reading-docs', keywords: ['obsidian', '我的笔记库'] }],
      processTags: { obsidian: 'reading-docs' },
    }, null, 2), 'utf8');

    const rules = loadActivityRules();
    checkTag('自定义关键词 obsidian → reading-docs', { processName: 'obsidian', title: '我的笔记库 - Obsidian' }, 'reading-docs', rules);
    checkTag('自定义进程名兜底 obsidian → reading-docs', { processName: 'Obsidian', title: '随便什么标题' }, 'reading-docs', rules);
    // 追加而不是替换：内置规则照旧生效
    checkTag('自定义规则不覆盖掉内置规则（Chrome 仍然 browsing）', { processName: 'chrome', title: '某页面' }, 'browsing', rules);
    checkTag('自定义规则不覆盖掉内置规则（Code 仍然 coding）', { processName: 'Code', title: 'x.ts - Visual Studio Code' }, 'coding', rules);

    // 自定义规则**排在前面**，所以能抢在内置规则之前命中
    await writeFile(rulesFile, JSON.stringify({
      rules: [{ tag: 'listening-music', keywords: ['youtube'] }],
    }, null, 2), 'utf8');
    checkTag('自定义规则优先于内置规则（youtube → listening-music）',
      { processName: 'chrome', title: 'youtube' }, 'listening-music', loadActivityRules());
  }

  // 坏 JSON / 坏形状 → 退回内置默认
  {
    const defaults = JSON.stringify(DEFAULT_ACTIVITY_RULES);

    await writeFile(rulesFile, '{ 这不是合法 JSON', 'utf8');
    check('坏 JSON 退回内置默认', JSON.stringify(loadActivityRules()) === defaults);

    await writeFile(rulesFile, '', 'utf8');
    check('空文件退回内置默认', JSON.stringify(loadActivityRules()) === defaults);

    await writeFile(rulesFile, '[1,2,3]', 'utf8');
    check('顶层不是对象时退回内置默认', JSON.stringify(loadActivityRules()) === defaults);

    await writeFile(rulesFile, JSON.stringify({
      rules: [
        { tag: 'not-a-real-tag', keywords: ['foo'] },   // 标签不在闭集 → 丢掉
        { tag: 'coding', keywords: [] },                // 没有关键词 → 丢掉
        { tag: 'coding', keywords: 'not-an-array' },    // 形状不对 → 丢掉
        { tag: 'terminal', keywords: ['my-shell', 42, ''] }, // 只留合法关键词
      ],
      processTags: { weird: 'nope', goodapp: 'gaming' },
      defaultTag: 'definitely-not-a-tag',
    }), 'utf8');
    const strict = loadActivityRules();
    check('非法标签的规则被丢掉，合法的那条留下',
      strict.rules[0]?.tag === 'terminal' && strict.rules[0]?.keywords.join(',') === 'my-shell');
    check('非法 processTags 条目被丢掉，合法的留下', strict.processTags.goodapp === 'gaming' && strict.processTags.weird === undefined);
    check('非法 defaultTag 退回内置的 other',
      strict.defaultTag === DEFAULT_ACTIVITY_RULES.defaultTag && strict.defaultTag === 'other');
    checkTag('自定义规则生效（my-shell → terminal）', { processName: 'unknown', title: 'my-shell' }, 'terminal', strict);
    checkTag('未知应用仍然降级到 other', { processName: 'whatever-app', title: 'whatever' }, 'other', strict);

    // 直接删掉文件 → 也退回内置默认
    await rm(rulesFile, { force: true });
    check('规则文件不存在时退回内置默认', JSON.stringify(loadActivityRules()) === defaults);
    ensureActivityRulesFile(rulesFile);
  }

  // ── ④ 开关关闭时不采样 ───────────────────────────────────────────────────────

  console.log('\n=== ④ 开关关闭时一次都不采样 ===\n');

  /** 计数桩：setTimeout / clearTimeout 都不真做，sample 被调了几次一目了然 */
  function makeStubSampler() {
    const state = { sampleCalls: 0, scheduled: [] as Array<{ callback: () => void; delayMs: number }>, cancelled: 0 };
    return {
      state,
      options: {
        sample: async () => { state.sampleCalls += 1; return { processName: 'Code', title: 'x.ts - Visual Studio Code' }; },
        rules: () => loadActivityRules(),
        record: () => { },
        schedule: (callback: () => void, delayMs: number) => { state.scheduled.push({ callback, delayMs }); return 0 as unknown as ReturnType<typeof setTimeout>; },
        cancel: () => { state.cancelled += 1; },
        random: () => 0,
      },
    };
  }

  {
    const stub = makeStubSampler();
    const stop = startCompanionSampler({ enabled: false, ...stub.options });
    check('enabled=false 时一个定时器都不建', stub.state.scheduled.length === 0);
    check('enabled=false 时采样函数一次都没被调用', stub.state.sampleCalls === 0);
    check('enabled=false 时 stop() 不会崩', (() => { try { stop(); return true; } catch { return false; } })());
    // 就算强行把"定时器"跑起来也不该有定时器 —— 上一条已经断言为 0，这里再确认没有副作用
    check('enabled=false 时 sampleCalls 仍然是 0', stub.state.sampleCalls === 0);
  }

  {
    const stub = makeStubSampler();
    const stop = startCompanionSampler({ enabled: true, ...stub.options });
    check('enabled=true 时建了 1 个定时器', stub.state.scheduled.length === 1);
    check('启动时**不**立刻采样（只排定时器）', stub.state.sampleCalls === 0);
    const first = stub.state.scheduled[0] as { delayMs: number };
    check('第一次采样排在 [20,45] 分钟后', first.delayMs >= COMPANION_MIN_INTERVAL_MS && first.delayMs <= COMPANION_MAX_INTERVAL_MS,
      `${Math.round(first.delayMs / 60_000)} 分钟`);

    // 手动触发一次 tick：应该正好采样一次，然后排下一个定时器
    first.callback();
    await new Promise((resolve) => setTimeout(resolve, 10));
    check('触发一次 tick 后采样正好 1 次', stub.state.sampleCalls === 1, `实际 ${stub.state.sampleCalls}`);
    check('tick 之后又排了下一个定时器', stub.state.scheduled.length === 2);

    stop();
    check('stop() 会取消挂着的定时器', stub.state.cancelled >= 1);

    // 停止之后定时器不该再被排
    const before = stub.state.scheduled.length;
    await new Promise((resolve) => setTimeout(resolve, 10));
    check('stop() 之后不再排新定时器', stub.state.scheduled.length === before);
  }

  {
    // 采样失败（读不到窗口）→ 静默跳过，不记录、不抛。
    // ⚠️ 这里的假 schedule **只能让 tick 跑一次**：如果它每次都重新调度，
    // tick 末尾又会调度一次 → 死循环（第一版就是这么把探针挂死的）。
    let recorded = 0;
    const errors: string[] = [];
    let ticks = 0;
    const stop = startCompanionSampler({
      enabled: true,
      sample: async () => undefined,
      rules: () => loadActivityRules(),
      record: () => { recorded += 1; },
      schedule: (callback) => {
        // 只放行第一次；之后的（tick 末尾排的那个）忽略，让进程能退出
        if (ticks === 0) { ticks += 1; setImmediate(callback); }
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
      cancel: () => { },
      onError: (message) => errors.push(message),
    });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    stop();
    check('读不到窗口时静默跳过（不记样本、不报错）', recorded === 0 && errors.length === 0,
      `recorded=${recorded} errors=${errors.length}`);
  }

  // ── ⑤ 活动历史 ───────────────────────────────────────────────────────────────

  console.log('\n=== ⑤ 活动历史（只存标签 + 时间）===\n');

  {
    clearActivityHistory();
    check('清空之后历史为空', getActivityHistory().length === 0);
    check('历史为空时 latestActivity 是 undefined', latestActivity() === undefined);

    for (let i = 0; i < 15; i += 1) {
      recordActivity({ tag: 'coding', at: 1_700_000_000_000 + i * 60_000, processName: `proc-${i}` });
    }
    const history = getActivityHistory();
    check(`历史上限是 ${COMPANION_HISTORY_LIMIT} 条`, history.length === COMPANION_HISTORY_LIMIT, `实际 ${history.length}`);
    check('超限时丢的是最旧的（保留最新的 10 条）',
      history[0]?.processName === 'proc-5' && history[history.length - 1]?.processName === 'proc-14');

    const serialized = JSON.stringify(history);
    check('历史条目里只有 tag / at / processName（没有 title 字段）',
      !serialized.includes('"title"') && history.every((item) => typeof item.tag === 'string' && typeof item.at === 'number'));
    check('历史里的 tag 全是闭集标签', history.every((item) => isCompanionTag(item.tag)));
    check('历史里不含 marker', !serialized.includes(MARKER));

    // 同一个应用连续采样合并成一条
    clearActivityHistory();
    recordActivity({ tag: 'browsing', at: 1_700_000_000_000, processName: 'chrome' });
    recordActivity({ tag: 'browsing', at: 1_700_000_600_000, processName: 'chrome' });
    check('同标签同进程连续采样合并成一条', getActivityHistory().length === 1);
    recordActivity({ tag: 'coding', at: 1_700_001_200_000, processName: 'code' });
    check('换了标签就开新的一条', getActivityHistory().length === 2);
    recordActivity({ tag: 'browsing', at: 1_700_001_800_000, processName: 'chrome' });
    check('标签来回切换会各开一条', getActivityHistory().length === 3);

    clearActivityHistory();
    check('清空可用', getActivityHistory().length === 0);
  }

  // ── ⑥ 采样间隔 ───────────────────────────────────────────────────────────────

  console.log('\n=== ⑥ 采样间隔落在 [20, 45] 分钟 ===\n');

  {
    const span = COMPANION_MAX_INTERVAL_MS - COMPANION_MIN_INTERVAL_MS;
    check('下限是 20 分钟', COMPANION_MIN_INTERVAL_MS === 20 * 60_000);
    check('上限是 45 分钟', COMPANION_MAX_INTERVAL_MS === 45 * 60_000);

    check('random=0 → 正好是下限 20 分钟', nextSampleDelay(() => 0) === COMPANION_MIN_INTERVAL_MS);
    check('random=1 → 正好是上限 45 分钟', nextSampleDelay(() => 1) === COMPANION_MAX_INTERVAL_MS);
    check('random=0.5 → 落在区间正中间', nextSampleDelay(() => 0.5) === COMPANION_MIN_INTERVAL_MS + Math.round(span / 2));
    check('random 越界（2 / -1）被夹住',
      nextSampleDelay(() => 2) === COMPANION_MAX_INTERVAL_MS && nextSampleDelay(() => -1) === COMPANION_MIN_INTERVAL_MS);
    check('random 返回 NaN 时不炸（落回下限）', nextSampleDelay(() => Number.NaN) === COMPANION_MIN_INTERVAL_MS);

    // 大量随机值都必须落在区间内，且不能是"固定心跳"（至少出现过多个不同值）
    const seen = new Set<number>();
    let inRange = true;
    for (let i = 0; i < 2000; i += 1) {
      const delay = nextSampleDelay();
      seen.add(delay);
      if (delay < COMPANION_MIN_INTERVAL_MS || delay > COMPANION_MAX_INTERVAL_MS) inRange = false;
    }
    check('2000 次随机采样间隔全部落在 [20,45] 分钟', inRange);
    check('间隔确实随机（不是固定心跳）', seen.size > 100, `${seen.size} 个不同取值`);
  }

  // ── ⑦ 注入（pi.on('context')）───────────────────────────────────────────────

  console.log('\n=== ⑦ 注入：只在新鲜时、且不含任何标题字符 ===\n');

  {
    /** 假 ExtensionAPI：只实现 on()，把 context 处理器抓出来 */
    const handlers: Array<(event: { type: string; messages: unknown[] }) => unknown> = [];
    const fakePi = {
      on: (eventName: string, handler: (event: unknown) => unknown) => {
        if (eventName === 'context') handlers.push(handler as (event: { type: string; messages: unknown[] }) => unknown);
        return () => { };
      },
    };

    const sample = { tag: 'coding' as const, at: 1_700_000_000_000, processName: 'code' };
    const SECRET_TITLE = `${MARKER} 我真正的窗口标题`;
    await createCompanionExtension({ getLatest: () => sample, now: () => 1_700_000_000_000 })(fakePi as never);

    check('注册了且只注册了 1 个 context 处理器', handlers.length === 1, `实际 ${handlers.length}`);
    const handler = handlers[0] as (event: { type: string; messages: unknown[] }) => { messages?: unknown[] } | undefined;

    // 新鲜（0 分钟）
    const fresh = handler({ type: 'context', messages: [{ role: 'user', content: 'hi' }] });
    check('新鲜时注入了 1 条消息', fresh?.messages?.length === 2);
    const injected = fresh?.messages?.[1] as { role: string; customType: string; content: string; display: boolean };
    check('注入的是 custom 消息且 display=false（不进 UI 记录）',
      injected?.role === 'custom' && injected?.display === false && injected?.customType === 'companion-awareness');
    check('注入内容 = 预期的一行提示词',
      injected?.content === '活动参考：主人正在 coding（已 0 分钟）。', injected?.content);
    check('注入内容里没有任何标题字符 / marker',
      !injected?.content.includes(MARKER) && !injected?.content.includes(SECRET_TITLE));
    check('注入内容很短（≤ 40 字符，约 25 token 以内）', injected.content.length <= 40, `${injected.content.length} 字符`);
    check('注入不会改动传进来的 messages 数组（只读入参）',
      (fresh?.messages?.[0] as { content: string }) === undefined ? false : true);

    // 新鲜边缘：9 分钟前还注入，10 分钟前就不注入了
    const nineMinutesAgo = (tag: string, at: number, now: number) =>
      buildActivityHint({ tag: tag as never, at, processName: 'code' }, now);

    // 换一个 now = 9 分钟后的扩展实例来验"边缘还算新鲜"
    const freshEdgeHandlers: Array<(event: { type: string; messages: unknown[] }) => unknown> = [];
    const freshEdgePi = { on: (_n: string, h: (event: unknown) => unknown) => { freshEdgeHandlers.push(h as (event: { type: string; messages: unknown[] }) => unknown); return () => { }; } };
    await createCompanionExtension({ getLatest: () => sample, now: () => sample.at + 9 * 60_000 })(freshEdgePi as never);
    const edge = (freshEdgeHandlers[0] as (event: { type: string; messages: unknown[] }) => { messages?: unknown[] } | undefined)({ type: 'context', messages: [] });
    check('9 分钟前的标签仍然注入', edge?.messages?.length === 1);
    check('9 分钟前的标签还算新鲜', activityAge(sample, sample.at + 9 * 60_000).fresh);
    check('10 分钟前的标签就不再新鲜', activityAge(sample, sample.at + 10 * 60_000).fresh === false);
    check('9 分钟时注入的分钟数是 9', nineMinutesAgo('coding', sample.at, sample.at + 9 * 60_000) === '活动参考：主人正在 coding（已 9 分钟）。',
      String(nineMinutesAgo('coding', sample.at, sample.at + 9 * 60_000)));

    // 过期：20 分钟前 → 不注入
    const staleHandlers: Array<(event: { type: string; messages: unknown[] }) => unknown> = [];
    const stalePi = { on: (_n: string, h: (event: unknown) => unknown) => { staleHandlers.push(h as (event: { type: string; messages: unknown[] }) => unknown); return () => { }; } };
    await createCompanionExtension({ getLatest: () => sample, now: () => sample.at + 20 * 60_000 })(stalePi as never);
    const stale = (staleHandlers[0] as (event: unknown) => unknown)({ type: 'context', messages: [] });
    check('过期（20 分钟前）时不注入', stale === undefined || (stale as { messages?: unknown[] }).messages === undefined);

    // 历史为空 → 不注入
    const emptyHandlers: Array<(event: { type: string; messages: unknown[] }) => unknown> = [];
    const emptyPi = { on: (_n: string, h: (event: unknown) => unknown) => { emptyHandlers.push(h as (event: { type: string; messages: unknown[] }) => unknown); return () => { }; } };
    await createCompanionExtension({ getLatest: () => undefined, now: () => Date.now() })(emptyPi as never);
    const nothing = (emptyHandlers[0] as (event: unknown) => unknown)({ type: 'context', messages: [] });
    check('历史为空时不注入', nothing === undefined || (nothing as { messages?: unknown[] }).messages === undefined);

    // 每个标签拼出来的提示词都不含自由文本。
    // ⚠️ now 必须落在保鲜期内（<10 分钟），否则 buildActivityHint 直接返回 undefined。
    let allShort = true;
    const violations: string[] = [];
    for (const tag of ACTIVITY_TAGS) {
      const hint = buildActivityHint({ tag, at: 1_700_000_000_000, processName: `${MARKER}-proc` }, 1_700_000_000_000 + 6 * 60_000);
      if (hint === undefined) { violations.push(`${tag}: 未注入`); continue; }
      if (hint.length > 40) allShort = false;
      if (hint.includes(MARKER) || hint.includes('proc')) violations.push(`${tag}: ${hint}`);
      if (!hint.includes(tag)) violations.push(`${tag}: 标签没出现在提示词里`);
    }
    check('14 个标签的提示词都 ≤ 40 字符', allShort);
    check('14 个标签的提示词都不含进程名 / marker', violations.length === 0, violations.join(' | '));
    check('提示词形状：0 分钟前采的、now=5 分钟 → 已 5 分钟',
      buildActivityHint({ tag: 'coding', at: 0, processName: 'code' }, 5 * 60_000) === '活动参考：主人正在 coding（已 5 分钟）。');
    check('过期就不注入（at=0、now=25 分钟 → undefined）',
      buildActivityHint({ tag: 'coding', at: 0, processName: 'code' }, 25 * 60_000) === undefined);
    check('提示词用「已 N 分钟」的整数分钟（7 分 30 秒 → 7）',
      buildActivityHint({ tag: 'terminal', at: 1_000_000, processName: 'pwsh' }, 1_000_000 + 7 * 60_000 + 30_000) === '活动参考：主人正在 terminal（已 7 分钟）。');
  }

  // ── ⑧ 落盘扫描：marker 绝不能出现在任何文件里 ────────────────────────────────

  console.log('\n=== ⑧ 落盘扫描（marker 不得出现在任何文件里）===\n');

  /** 递归收集目录下所有文件 */
  async function listFiles(root: string): Promise<string[]> {
    const found: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) found.push(full);
      }
    };
    await walk(root);
    return found;
  }

  {
    // 把带 marker 的样本再喂一遍分类器 + 记进历史（模拟真实运行路径）
    const rules = loadActivityRules();
    for (const sample of SAMPLES) {
      if (!sample.window.title.includes(MARKER)) continue;
      const result = classifyActivity(sample.window, rules);
      recordActivity({ tag: result.tag, at: Date.now(), processName: sample.window.processName });
    }

    const files = await listFiles(PET_ROOT);
    let leaked: string[] = [];
    for (const file of files) {
      const bytes = await readFile(file);
      if (bytes.includes(Buffer.from(MARKER, 'utf8'))) leaked.push(file);
    }
    check(`临时根目录下 ${files.length} 个文件里都没有 marker`, leaked.length === 0, leaked.join(', '));
    console.log(`   扫描过的文件：\n${files.map((file) => `     · ${path.relative(PET_ROOT, file)}`).join('\n')}`);

    // 真实目录：探针跑之前先确认它没被创建/修改（只读检查，绝不写）
    const realRules = path.join(process.env.APPDATA ?? '', '肆', 'activity-rules.json');
    check('探针用的是临时目录，不是真实的 %APPDATA%\\肆',
      rulesFile !== realRules && rulesFile.startsWith(os.tmpdir()), `探针路径=${rulesFile}`);
  }

  // ── 收尾 ─────────────────────────────────────────────────────────────────────

  await rm(PET_ROOT, { recursive: true, force: true });
  console.log(`\n临时目录已删除：${PET_ROOT}`);
  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  if (failed > 0) process.exitCode = 1;
}

void main().catch((error) => {
  console.error('\n[探针失败]');
  console.error(error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error));
  process.exitCode = 1;
});
