/**
 * probe-update-check.ts —— 「检查更新」的**零网络、零 API 成本**自测。
 *
 * 它验的（全部不联网、不起 Electron、不碰真实 %APPDATA%\肆）：
 *   ① compareVersions：新 / 旧 / 相同 / 补零相等（1.0 == 1.0.0）/ 垃圾字符串 → undefined
 *   ② shouldNotify：垃圾一律"不提示"；同版本不重复提示
 *   ③ 频率控制：7 天内不查 / 超过 7 天才查 / force 忽略限制 / off 完全不查 / 开关关掉不查
 *   ④ 提示去重：同一版本第二次不提示；版本变了又提示
 *   ⑤ 失败路径：网络抛错 / 非 200 / JSON 坏 / 缺 tag_name / 超时 → 静默、不写坏状态、不抛
 *   ⑥ 状态文件：坏 JSON 容错 / 目录不存在自动创建 / 字段类型不对退回空 / 时钟回拨
 *   ⑦ 气泡文案：本地模板（3 个变体都在）+ 版本号被替换进去
 *   ⑧ 隔离：所有落盘都发生在临时目录里，真实 %APPDATA%\肆 一个字节都不碰
 *
 * ⚠️ 这个探针**永远**给 runUpdateCheck 注入假的 fetchLatest —— 一次真实请求都不会发。
 *
 * 运行：
 *   cd F:\ss_yong\si\pet-si\pet-app
 *   npx tsx tools/probe-update-check.ts
 */
import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

// ⚠️ tsx 把探针编译成 CJS，所以这里不能靠 import.meta；环境变量用动态 require 前设好。
declare const require: (id: string) => unknown;

// ── 断言小工具（和 probe-companion 一个样式）─────────────────────────────────

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail = ''): void {
  if (ok) passed += 1;
  else failed += 1;
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ` —— ${detail}` : ''}`);
}

const DAY = 24 * 60 * 60 * 1000;

async function main(): Promise<void> {
  // 必须在加载 update-check 之前设好：状态文件要落在临时目录，绝不能碰真实 %APPDATA%\肆
  const PROBE_ROOT = await mkdtemp(path.join(os.tmpdir(), 'si-probe-update-'));
  process.env.PET_UPDATE_CHECK_ROOT = PROBE_ROOT;
  delete process.env.PET_UPDATE_CHECK;
  delete process.env.PET_PI_ROOT;

  const mod = require('../src/main/update-check.ts') as typeof import('../src/main/update-check.ts');
  const {
    CHECK_INTERVAL_MS,
    RELEASES_PAGE_URL,
    STARTUP_DELAY_MS,
    UPDATE_BUBBLE_TEMPLATES,
    buildUpdateBubble,
    compareVersions,
    emptyUpdateState,
    isCheckDue,
    isSameVersion,
    loadUpdateState,
    parseUpdateState,
    parseVersion,
    readUpdateCheckMode,
    runUpdateCheck,
    saveUpdateState,
    shouldNotify,
    updateStatePath,
  } = mod;

  type UpdateCheckState = import('../src/main/update-check.ts').UpdateCheckState;
  type LatestRelease = import('../src/main/update-check.ts').LatestRelease;

  const stateFile = updateStatePath();
  console.log(`临时根目录：${PROBE_ROOT}`);
  console.log(`状态文件：${stateFile}`);

  // ── 隔离自检 ──────────────────────────────────────────────────────────────

  console.log('\n=== ⓪ 隔离：状态文件落在临时目录 ===\n');
  check('状态文件在临时根目录里（没污染真实 %APPDATA%\\肆）', stateFile.startsWith(PROBE_ROOT), stateFile);
  check('状态文件名就是约定的 update-check.json', path.basename(stateFile) === 'update-check.json');
  check('状态文件不在真实的 %APPDATA% 下', !stateFile.startsWith(path.join(process.env.APPDATA ?? '___none___', '肆')));

  // ── ① compareVersions / parseVersion ─────────────────────────────────────

  console.log('\n=== ① compareVersions（纯函数）===\n');

  const COMPARE_CASES: Array<{ a: string; b: string; expected: 1 | 0 | -1 | undefined; label: string }> = [
    // 真正要支持的：新版本比当前版本新
    { a: '1.0.1', b: '1.0.0', expected: 1, label: '1.0.1 > 1.0.0' },
    { a: 'v1.0.1', b: '1.0.0', expected: 1, label: 'v1.0.1 > 1.0.0（前导 v 被去掉）' },
    { a: 'v1.1.0', b: '1.0.0', expected: 1, label: 'v1.1.0 > 1.0.0' },
    { a: '2.0.0', b: '1.0.0', expected: 1, label: '2.0.0 > 1.0.0' },
    { a: '1.0.10', b: '1.0.9', expected: 1, label: '1.0.10 > 1.0.9（不是字符串比较！）' },
    { a: '1.10.0', b: '1.9.0', expected: 1, label: '1.10.0 > 1.9.0' },
    // 相同
    { a: '1.0.0', b: '1.0.0', expected: 0, label: '1.0.0 == 1.0.0' },
    { a: 'v1.0.0', b: '1.0.0', expected: 0, label: 'v1.0.0 == 1.0.0' },
    { a: '1.0', b: '1.0.0', expected: 0, label: '1.0 == 1.0.0（补零相等）' },
    { a: '1.0.0.0', b: '1.0.0', expected: 0, label: '1.0.0.0 == 1.0.0' },
    // 更旧
    { a: '1.0.0', b: '1.0.1', expected: -1, label: '1.0.0 < 1.0.1' },
    { a: '0.9.0', b: '1.0.0', expected: -1, label: '0.9.0 < 1.0.0' },
    { a: '1.0.0', b: 'v2.0.0', expected: -1, label: '1.0.0 < v2.0.0' },
    // 垃圾：一律 undefined（= 不提示）
    { a: 'abc', b: '1.0.0', expected: undefined, label: '垃圾 "abc"（左边）→ undefined' },
    { a: '1.0.0', b: 'abc', expected: undefined, label: '垃圾 "abc"（右边）→ undefined' },
    { a: '1.0', b: 'abc', expected: undefined, label: '1.0 vs abc → undefined' },
    { a: '', b: '1.0.0', expected: undefined, label: '空串 → undefined' },
    { a: '   ', b: '1.0.0', expected: undefined, label: '纯空白 → undefined' },
    { a: '1..0', b: '1.0.0', expected: undefined, label: '1..0（空段）→ undefined' },
    { a: '1.0.1-beta.1', b: '1.0.0', expected: undefined, label: '预发布后缀 → undefined（保守）' },
    { a: 'v1.0.1-rc1', b: '1.0.0', expected: undefined, label: 'rc 后缀 → undefined（保守）' },
    { a: '1.0.x', b: '1.0.0', expected: undefined, label: '含字母段 → undefined' },
    { a: '最新版', b: '1.0.0', expected: undefined, label: '中文 → undefined' },
    { a: '1.0.1+meta', b: '1.0.0', expected: undefined, label: 'build metadata → undefined（保守）' },
    { a: 'v', b: '1.0.0', expected: undefined, label: '只有一个 v → undefined' },
    { a: '1.0.0.0.0', b: '1.0.0', expected: undefined, label: '5 段 → undefined' },
    { a: '-1.0.0', b: '1.0.0', expected: undefined, label: '负号 → undefined' },
    { a: 'v1.0.1\n', b: '1.0.0', expected: 1, label: '尾随换行会被 trim 掉' },
  ];

  for (const item of COMPARE_CASES) {
    const actual = compareVersions(item.a, item.b);
    check(`compareVersions(${JSON.stringify(item.a)}, ${JSON.stringify(item.b)})：${item.label}`,
      actual === item.expected, `期望 ${String(item.expected)}，实际 ${String(actual)}`);
  }

  // 非字符串输入一律 undefined（renderer / 坏 JSON 都可能塞奇怪东西进来）
  for (const value of [null, undefined, 42, {}, [], true]) {
    check(`compareVersions(${JSON.stringify(value) ?? 'undefined'}, '1.0.0') → undefined`,
      compareVersions(value as never, '1.0.0') === undefined);
  }

  // parseVersion 的正反向
  check('parseVersion 去前导 v 并规范化（v01.0.1 → 1.0.1）',
    parseVersion('v01.0.1')?.canonical === '1.0.1', String(parseVersion('v01.0.1')?.canonical));
  check('parseVersion 的规范写法会掐掉末尾 0 段（1.0.0 → 1）',
    parseVersion('1.0.0')?.canonical === '1' && parseVersion('1.0')?.canonical === '1',
    `${String(parseVersion('1.0.0')?.canonical)} / ${String(parseVersion('1.0')?.canonical)}`);
  check('parseVersion 只掐末尾的 0（1.0.1 不受影响）', parseVersion('1.0.1')?.canonical === '1.0.1');
  check('parseVersion 全 0 时保留一段（0.0.0 → 0）', parseVersion('0.0.0')?.canonical === '0');
  check('parseVersion 的 parts 保留原样段数（1.0.0 → [1,0,0]）',
    JSON.stringify(parseVersion('1.0.0')?.parts) === '[1,0,0]', JSON.stringify(parseVersion('1.0.0')?.parts));
  check('parseVersion 超长字符串（>64）→ undefined', parseVersion('1'.repeat(80)) === undefined);
  check('parseVersion 接受大写 V', parseVersion('V1.2.3')?.canonical === '1.2.3');

  // isSameVersion：规范相等，不是字符串相等 —— 这条正是"1.0.10 vs 1.0.9"那个坑的解药
  check('isSameVersion(1.0.0, v1.0.0) === true', isSameVersion('1.0.0', 'v1.0.0'));
  check('isSameVersion(1.0, 1.0.0) === true（补零）', isSameVersion('1.0', '1.0.0'));
  check('isSameVersion(1.0.1, 1.0.0) === false', isSameVersion('1.0.1', '1.0.0') === false);
  check('isSameVersion(null, null) === false（解析不了就不认相等）', isSameVersion(null, null) === false);
  // ⚠️ 这条是回归测试：比较说"相等"、去重说"不等"就会导致同一个版本被反复提示。
  // 凡是 compareVersions 判 0 的一对，isSameVersion 必须为 true。
  {
    const pairs: Array<[string, string]> = [
      ['1.0', '1.0.0'], ['v1.0.0', '1.0'], ['1.0.0.0', '1'], ['2.1.0', 'v2.1'],
      ['0.0.0', '0'], ['1.0.0', 'v1.0.0.0'],
    ];
    const inconsistent = pairs.filter(([a, b]) => compareVersions(a, b) === 0 && !isSameVersion(a, b));
    check('比较与去重用的是同一把尺子（判"一样新"的必然判"同一个"）',
      inconsistent.length === 0, inconsistent.map(([a, b]) => `${a}/${b}`).join(', '));
    // 反向：'1.0.10' vs '1.0.9' 是字符串比较最容易出错的一对
    check('1.0.10 与 1.0.9 既"不等"也"不一样新"',
      isSameVersion('1.0.10', '1.0.9') === false && compareVersions('1.0.10', '1.0.9') === 1);
  }

  // ── ② shouldNotify：拿不准就不提示 ───────────────────────────────────────

  console.log('\n=== ② shouldNotify（拿不准就不提示）===\n');

  const NOTIFY_CASES: Array<{ current: unknown; latest: unknown; notified?: unknown; expected: boolean; label: string }> = [
    { current: '1.0.0', latest: 'v1.0.1', expected: true, label: '1.0.0 → v1.0.1：提示' },
    { current: '1.0.0', latest: '1.0.0', expected: false, label: '同版本：不提示' },
    { current: '1.0.0', latest: 'v1.0.0', expected: false, label: 'v1.0.0 与 1.0.0 同版本：不提示' },
    { current: '1.0.0', latest: '0.9.0', expected: false, label: '远端更旧：不提示' },
    { current: '1.0.0', latest: 'abc', expected: false, label: '远端是垃圾：不提示' },
    { current: 'abc', latest: '1.0.1', expected: false, label: '本机版本是垃圾：不提示' },
    { current: '1.0.0', latest: '', expected: false, label: '远端空串：不提示' },
    { current: '', latest: '', expected: false, label: '两边都空：不提示' },
    { current: '1.0.0', latest: '1.0.1-beta', expected: false, label: '远端带后缀：不提示' },
    { current: '1.0.0', latest: 'v1.0.1', notified: 'v1.0.1', expected: false, label: '这个版本已经喊过了：不提示' },
    { current: '1.0.0', latest: 'v1.0.1', notified: '1.0.1', expected: false, label: '喊过的版本写法不同但等价：不提示' },
    { current: '1.0.0', latest: 'v1.0.2', notified: 'v1.0.1', expected: true, label: '版本又变了：重新提示' },
    { current: '1.0.0', latest: 'v1.0.1', notified: 'abc', expected: true, label: '记的旧版本是垃圾：照常提示' },
    { current: '1.0.0', latest: 'v1.0.1', notified: null, expected: true, label: '从没喊过：提示' },
  ];

  for (const item of NOTIFY_CASES) {
    const actual = shouldNotify(item.current, item.latest, item.notified ?? null);
    check(`shouldNotify(${String(item.current)}, ${String(item.latest)}, ${String(item.notified ?? null)})：${item.label}`,
      actual === item.expected, `期望 ${item.expected}，实际 ${actual}`);
  }

  // ── ③ 环境变量模式 ───────────────────────────────────────────────────────

  console.log('\n=== ③ PET_UPDATE_CHECK 模式解析 ===\n');

  {
    const original = process.env.PET_UPDATE_CHECK;
    const cases: Array<[string | undefined, string]> = [
      [undefined, 'on'],
      ['', 'on'],
      ['off', 'off'],
      ['OFF', 'off'],
      [' off ', 'off'],
      ['force', 'force'],
      ['FORCE', 'force'],
      ['on', 'on'],
      ['随便什么', 'on'],
    ];
    let allOk = true;
    const details: string[] = [];
    for (const [value, expected] of cases) {
      if (value === undefined) delete process.env.PET_UPDATE_CHECK;
      else process.env.PET_UPDATE_CHECK = value;
      const actual = readUpdateCheckMode();
      if (actual !== expected) { allOk = false; details.push(`${String(value)} → ${actual}（期望 ${expected}）`); }
    }
    check('PET_UPDATE_CHECK 的 9 种取值都解析正确', allOk, details.join(' | '));
    if (original === undefined) delete process.env.PET_UPDATE_CHECK;
    else process.env.PET_UPDATE_CHECK = original;
  }

  // ── ④ runUpdateCheck：频率控制 / 去重 / 失败路径 ──────────────────────────
  //
  // 一个可复用的测试台：可控时钟、可注入的 fetchLatest（**永不联网**）、
  // 真实的状态文件读写（落在临时目录）。

  interface Harness {
    stateFile: string;
    now: number;
    fetchCalls: number;
    bubbles: string[];
    banners: Array<{ latestVersion: string; url: string }>;
    logs: Array<{ level: string; event: string; details?: Record<string, unknown> }>;
    lastFetchResult: LatestRelease | (() => Promise<LatestRelease>);
    run: (overrides?: Partial<import('../src/main/update-check.ts').UpdateCheckDeps>) => ReturnType<typeof runUpdateCheck>;
  }

  let scenarioCounter = 0;

  async function makeHarness(options: {
    currentVersion?: string;
    enabled?: boolean;
    mode?: 'on' | 'off' | 'force';
    /** 假 fetchLatest 的返回值；给函数就用那个函数 */
    release?: LatestRelease | (() => Promise<LatestRelease>);
    /** 预置的状态文件内容（写进临时目录里一个独立文件） */
    seedState?: string;
    /** 预置状态对象（比 seedState 方便） */
    seed?: UpdateCheckState;
    startNow?: number;
    /** 直接指定状态文件路径（默认每个场景一个独立文件） */
    file?: string;
  } = {}): Promise<Harness> {
    scenarioCounter += 1;
    const file = options.file ?? path.join(PROBE_ROOT, `scenario-${scenarioCounter}`, 'update-check.json');
    if (options.seed) await saveUpdateState(options.seed, file);
    else if (options.seedState !== undefined) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, options.seedState, 'utf8');
    }
    const harness: Harness = {
      stateFile: file,
      now: options.startNow ?? Date.UTC(2025, 0, 1),
      fetchCalls: 0,
      bubbles: [],
      banners: [],
      logs: [],
      lastFetchResult: options.release ?? { tag: 'v1.0.1' },
      run: (overrides = {}) => runUpdateCheck({
        currentVersion: options.currentVersion ?? '1.0.0',
        enabled: options.enabled ?? true,
        notifyBubble: (text) => { harness.bubbles.push(text); return true; },
        notifyBanner: (state) => { harness.banners.push(state); },
        stateFile: file,
        now: () => harness.now,
        random: () => 0,
        fetchLatest: async () => {
          harness.fetchCalls += 1;
          const result = harness.lastFetchResult;
          return typeof result === 'function' ? result() : result;
        },
        log: (level, event, details) => { harness.logs.push({ level, event, details }); },
        // 默认 'on'，不受环境变量影响；要验环境变量那条路就显式传 mode
        mode: options.mode ?? 'on',
        ...overrides,
      }),
    };
    return harness;
  }

  console.log('\n=== ④ 频率控制（注入时钟，不真等 7 天）===\n');

  check('CHECK_INTERVAL_MS 正好是 7 天', CHECK_INTERVAL_MS === 7 * DAY, String(CHECK_INTERVAL_MS));
  check('STARTUP_DELAY_MS 是 30 秒', STARTUP_DELAY_MS === 30_000);
  check('下载页地址写死成 GitHub Release 页', RELEASES_PAGE_URL === 'https://github.com/ssss203/si/releases/latest');

  {
    // 第一次跑：从没查过 → 查
    const h = await makeHarness();
    const outcome = await h.run();
    check('首次运行（无状态文件）会查', h.fetchCalls === 1 && outcome.checked === true);
    check('首次运行就发现了新版本', outcome.found === true && outcome.reason === 'ok');
    const saved = JSON.parse(await readFile(h.stateFile, 'utf8')) as UpdateCheckState;
    check('状态文件写下了 lastCheckedAt / lastSeenVersion / lastNotifiedVersion',
      typeof saved.lastCheckedAt === 'string'
      && saved.lastSeenVersion === 'v1.0.1'
      && saved.lastNotifiedVersion === 'v1.0.1',
      JSON.stringify(saved));
    check('lastCheckedAt 是注入时钟的那个时刻', saved.lastCheckedAt === new Date(h.now).toISOString());
  }

  {
    // 7 天内不再查
    const h = await makeHarness({
      seed: { lastCheckedAt: new Date(Date.UTC(2025, 0, 1)).toISOString(), lastSeenVersion: 'v1.0.1', lastNotifiedVersion: 'v1.0.1' },
      startNow: Date.UTC(2025, 0, 1) + 6 * DAY,
      release: { tag: 'v9.9.9' },
    });
    const outcome = await h.run();
    check('距上次检查 6 天：一次请求都不发', h.fetchCalls === 0, `fetchCalls=${h.fetchCalls}`);
    check('隔太久没到时 reason=interval', outcome.reason === 'interval' && outcome.checked === false);
    check('不查就不会动状态文件（lastSeenVersion 还是旧的）',
      (JSON.parse(await readFile(h.stateFile, 'utf8')) as UpdateCheckState).lastSeenVersion === 'v1.0.1');
  }

  {
    // 正好 7 天 → 查（边界是 >=）
    const h = await makeHarness({
      seed: { lastCheckedAt: new Date(Date.UTC(2025, 0, 1)).toISOString(), lastSeenVersion: 'v1.0.1', lastNotifiedVersion: 'v1.0.1' },
      startNow: Date.UTC(2025, 0, 1) + CHECK_INTERVAL_MS,
      release: { tag: 'v1.0.1' },
    });
    const outcome = await h.run();
    check('正好 7 天：会查（>= 而不是 >）', h.fetchCalls === 1 && outcome.checked === true);
  }

  {
    // 超过 7 天 → 查，而且发现新版本要提示
    const h = await makeHarness({
      seed: { lastCheckedAt: new Date(Date.UTC(2025, 0, 1)).toISOString(), lastSeenVersion: 'v1.0.1', lastNotifiedVersion: 'v1.0.1' },
      startNow: Date.UTC(2025, 0, 1) + 7 * DAY + 60_000,
      release: { tag: 'v1.0.2' },
    });
    const outcome = await h.run();
    check('超过 7 天 + 有新版本：查了并提示', h.fetchCalls === 1 && outcome.found === true);
    check('提示了两处：气泡 + 通话窗口那一行', h.bubbles.length === 1 && h.banners.length === 1);
    check('气泡文案里带上了新版本号', h.bubbles[0]?.includes('v1.0.2') === true, h.bubbles[0]);
    check('那一行拿到的 url 是主进程写死的下载页', h.banners[0]?.url === RELEASES_PAGE_URL);
    check('lastNotifiedVersion 更新成新版本了',
      (JSON.parse(await readFile(h.stateFile, 'utf8')) as UpdateCheckState).lastNotifiedVersion === 'v1.0.2');
  }

  {
    // force：忽略 7 天限制
    const h = await makeHarness({
      mode: 'force',
      seed: { lastCheckedAt: new Date(Date.UTC(2025, 0, 1)).toISOString(), lastSeenVersion: 'v1.0.1', lastNotifiedVersion: 'v1.0.0' },
      startNow: Date.UTC(2025, 0, 1) + 60_000,   // 才过 1 分钟
      release: { tag: 'v1.0.1' },
    });
    const outcome = await h.run();
    check('force 模式忽略 7 天限制，立刻就查', h.fetchCalls === 1 && outcome.checked === true, `fetchCalls=${h.fetchCalls}`);
    check('force 模式下有新版本照样提示', outcome.found === true && h.bubbles.length === 1);
  }

  {
    // off：完全不查，连状态文件都不读（用一个"读了就会篡改内容"的桩来证明）
    let loadCalls = 0;
    const h = await makeHarness({
      mode: 'off',
      seed: { lastCheckedAt: null, lastSeenVersion: null, lastNotifiedVersion: null },
      release: { tag: 'v9.9.9' },
    });
    const outcome = await h.run({ loadState: (file) => { loadCalls += 1; return loadUpdateState(file); } });
    check('PET_UPDATE_CHECK=off：一次请求都不发', h.fetchCalls === 0);
    check('PET_UPDATE_CHECK=off：连状态文件都不读', loadCalls === 0, `loadCalls=${loadCalls}`);
    check('PET_UPDATE_CHECK=off：reason=off 且不提示', outcome.reason === 'off' && h.bubbles.length === 0);
  }

  {
    // 开关关掉（cozeConfig.checkUpdates === false）
    const h = await makeHarness({ enabled: false, release: { tag: 'v9.9.9' } });
    const outcome = await h.run();
    check('开关关掉：一次请求都不发', h.fetchCalls === 0);
    check('开关关掉：reason=disabled，不提示、不写状态',
      outcome.reason === 'disabled' && h.bubbles.length === 0
      && await stat(h.stateFile).then(() => false).catch(() => true));
  }

  console.log('\n=== ⑤ 提示去重（同一个新版本只喊一次）===\n');

  {
    const fixedFile = path.join(PROBE_ROOT, 'dedupe', 'update-check.json');
    const base = Date.UTC(2025, 0, 1);
    // 第一次：发现 v1.0.1 → 提示
    const first = await makeHarness({ file: fixedFile, startNow: base, release: { tag: 'v1.0.1' } });
    const firstOutcome = await first.run();
    check('第一次发现 v1.0.1：提示', firstOutcome.found === true && first.bubbles.length === 1);

    // 第二次（隔了 8 天，频率上允许查）：还是 v1.0.1 → **不提示**
    const second = await makeHarness({ file: fixedFile, startNow: base + 8 * DAY, release: { tag: 'v1.0.1' } });
    const secondOutcome = await second.run();
    check('第二次（8 天后）还是 v1.0.1：查了但不再提示',
      second.fetchCalls === 1 && secondOutcome.found === false && second.bubbles.length === 0,
      `found=${secondOutcome.found} bubbles=${second.bubbles.length}`);
    check('不提示的原因记成 already-notified', secondOutcome.reason === 'already-notified', secondOutcome.reason);

    // 第三次：版本变成 v1.0.2 → 又提示
    const third = await makeHarness({ file: fixedFile, startNow: base + 16 * DAY, release: { tag: 'v1.0.2' } });
    const thirdOutcome = await third.run();
    check('版本变了（v1.0.2）：又提示', thirdOutcome.found === true && third.bubbles.length === 1);
    check('第三次的 lastNotifiedVersion 是 v1.0.2',
      (JSON.parse(await readFile(fixedFile, 'utf8')) as UpdateCheckState).lastNotifiedVersion === 'v1.0.2');

    // 第四次：远端反而更旧 → 不提示（主人没降级的必要）
    const fourth = await makeHarness({ file: fixedFile, startNow: base + 24 * DAY, release: { tag: 'v0.9.0' } });
    const fourthOutcome = await fourth.run();
    check('远端更旧（v0.9.0）：不提示', fourthOutcome.found === false && fourth.bubbles.length === 0);
    check('更旧的原因记成 not-newer', fourthOutcome.reason === 'not-newer', fourthOutcome.reason);

    // 第五次：远端是垃圾 tag → 不提示，而且不写坏状态
    const fifth = await makeHarness({ file: fixedFile, startNow: base + 32 * DAY, release: { tag: 'nightly-build' } });
    const fifthOutcome = await fifth.run();
    const afterFifth = JSON.parse(await readFile(fixedFile, 'utf8')) as UpdateCheckState;
    check('远端 tag 是垃圾（nightly-build）：不提示', fifthOutcome.found === false && fifth.bubbles.length === 0);
    check('垃圾 tag 不会被写进 lastNotifiedVersion（还是 v1.0.2）', afterFifth.lastNotifiedVersion === 'v1.0.2');
    check('但 lastSeenVersion 会如实记下看到的原样 tag', afterFifth.lastSeenVersion === 'nightly-build');
  }

  {
    // 主人当前版本比远端还新（自己编译的 dev 版）→ 不提示
    const h = await makeHarness({ currentVersion: '1.1.0', release: { tag: 'v1.0.5' } });
    const outcome = await h.run();
    check('本机 1.1.0 比远端 v1.0.5 新：不提示', outcome.found === false && h.bubbles.length === 0);
  }

  console.log('\n=== ⑥ 失败路径（全部静默、不写坏状态、不抛）===\n');

  {
    // 网络抛错
    const h = await makeHarness({ release: () => Promise.reject(new Error('getaddrinfo ENOTFOUND api.github.com')) });
    const outcome = await h.run();
    check('网络失败：不抛异常，返回 reason=error', outcome.reason === 'error' && outcome.checked === true);
    check('网络失败：不提示', h.bubbles.length === 0 && h.banners.length === 0);
    check('网络失败：不写状态文件（下次启动会再试，不是"等 7 天"）',
      await stat(h.stateFile).then(() => false).catch(() => true));
    // ⚠️ 只断言"日志的形状"：一条 warn + 一个固定的事件名。
    // 不断言 message 里没有域名 —— 引擎给的 getaddrinfo 报文本身就带主机名，
    // 那是**错误信息**不是我们主动写进去的 URL（真正要防的是代码里拼 URL 进日志）。
    check('网络失败：日志里正好一条 warn、事件名固定',
      h.logs.length === 1 && h.logs[0]?.level === 'warn' && h.logs[0]?.event === 'update-check-failed',
      JSON.stringify(h.logs));
    check('网络失败：日志的 details 里只有 message 一个字段（没有 URL / 没有响应体）',
      JSON.stringify(Object.keys(h.logs[0]?.details ?? {})) === '["message"]',
      JSON.stringify(h.logs[0]?.details));
  }

  {
    // 非 200（403 限流 / 404 仓库改名）
    for (const status of [403, 404, 500]) {
      const h = await makeHarness({ release: () => Promise.reject(new Error(`GitHub API responded ${status}`)) });
      const outcome = await h.run();
      check(`HTTP ${status}：静默失败、不提示`, outcome.reason === 'error' && h.bubbles.length === 0);
    }
  }

  {
    // JSON 坏 / 缺 tag_name / tag 类型不对 —— 用真实的 fetchLatestRelease + 假 fetch 走一遍
    const fakeResponse = (body: unknown, ok = true, status = 200): Response => ({
      ok,
      status,
      json: async () => body,
    }) as unknown as Response;

    const badResponses: Array<{ label: string; response: Response }> = [
      { label: '非 200', response: fakeResponse({ tag_name: 'v1.0.1' }, false, 500) },
      { label: '顶层不是对象', response: fakeResponse([1, 2, 3]) },
      { label: '没有 tag_name', response: fakeResponse({ name: 'release' }) },
      { label: 'tag_name 是数字', response: fakeResponse({ tag_name: 123 }) },
      { label: 'tag_name 是空串', response: fakeResponse({ tag_name: '   ' }) },
      { label: 'tag_name 超长', response: fakeResponse({ tag_name: 'v'.repeat(200) }) },
      { label: 'body 不是 JSON', response: { ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token < in JSON'); } } as unknown as Response },
    ];

    let allRejected = true;
    const details: string[] = [];
    for (const item of badResponses) {
      try {
        await mod.fetchLatestRelease({ fetchImpl: async () => item.response });
        allRejected = false;
        details.push(`${item.label}: 居然没抛`);
      } catch {
        // 期望就是抛
      }
    }
    check('7 种坏响应全部抛错（由 runUpdateCheck 统一吞掉）', allRejected, details.join(' | '));

    // 好响应要能解析出 tag
    const good = await mod.fetchLatestRelease({ fetchImpl: async () => fakeResponse({ tag_name: '  v1.0.1  ' }) });
    check('正常响应解析出 trim 过的 tag_name', good.tag === 'v1.0.1', good.tag);

    // 带上约定的两个头（User-Agent 不带 GitHub 会 403）
    let seenHeaders: Record<string, string> = {};
    await mod.fetchLatestRelease({
      fetchImpl: async (_url: string, init: { headers: Record<string, string> }) => {
        seenHeaders = init.headers;
        return fakeResponse({ tag_name: 'v1.0.1' });
      },
    });
    check('请求带了 User-Agent 和 Accept: application/vnd.github+json',
      typeof seenHeaders['User-Agent'] === 'string' && seenHeaders.Accept === 'application/vnd.github+json',
      JSON.stringify(seenHeaders));
  }

  {
    // 超时：8 秒的 AbortController 必须真的 abort（探针不真等 8 秒，把超时注入成 20ms）
    const started = Date.now();
    let aborted = false;
    let timeoutError: unknown;
    try {
      await mod.fetchLatestRelease({
        timeoutMs: 20,
        // 一个"永远不返回，除非被 abort"的假 fetch —— 一次网络请求都不会发
        fetchImpl: (_url: string, init: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => { aborted = true; reject(new Error('The operation was aborted')); }, { once: true });
        }),
      });
    } catch (error) {
      timeoutError = error;
    }
    const elapsed = Date.now() - started;
    check('超时会 abort 掉请求并抛错', aborted && timeoutError instanceof Error, String(timeoutError));
    check(`超时按注入的 20ms 生效（实际 ${elapsed}ms，没有真等 8 秒）`, elapsed < 2000);

    // 超时在 runUpdateCheck 那一层同样是静默
    const h = await makeHarness({ release: () => Promise.reject(new Error('The operation was aborted')) });
    const outcome = await h.run();
    check('超时在 runUpdateCheck 里也是静默失败', outcome.reason === 'error' && h.bubbles.length === 0);
  }

  {
    // 外部 signal（app 退出）能取消
    const controller = new AbortController();
    const h = await makeHarness({
      release: () => new Promise<LatestRelease>((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
    });
    const pending = h.run({ signal: controller.signal });
    controller.abort();
    const outcome = await pending;
    check('退出时 abort 掉在飞的请求：静默收场，不抛', outcome.reason === 'error' && h.bubbles.length === 0);
  }

  {
    // 状态文件写不动（目录被一个同名文件占住）→ 提示照发，不抛
    const blocked = path.join(PROBE_ROOT, 'blocked');
    await mkdir(path.dirname(blocked), { recursive: true });
    await writeFile(blocked, 'not a directory', 'utf8');
    const h = await makeHarness({ release: { tag: 'v1.0.1' } });
    const outcome = await h.run({ stateFile: path.join(blocked, 'update-check.json') });
    check('状态文件写不动时：照样提示、不抛异常', outcome.found === true && h.bubbles.length === 1);
  }

  {
    // 气泡发送失败（桌宠窗口还没建好）→ 不该反复提示，也不该崩
    const h = await makeHarness({ release: { tag: 'v1.0.1' } });
    const outcome = await h.run({ notifyBubble: () => false });
    check('没窗口可弹时：返回 shown=false 但仍是"已提示过"（记 lastNotifiedVersion）',
      outcome.found === true
      && (JSON.parse(await readFile(h.stateFile, 'utf8')) as UpdateCheckState).lastNotifiedVersion === 'v1.0.1');
  }

  console.log('\n=== ⑦ 状态文件读写（坏 JSON 容错 + 目录自动创建）===\n');

  check('空状态是三个 null', JSON.stringify(emptyUpdateState()) === '{"lastCheckedAt":null,"lastSeenVersion":null,"lastNotifiedVersion":null}');

  {
    const file = path.join(PROBE_ROOT, 'io', 'nested', 'deep', 'update-check.json');
    check('目标目录还不存在', await stat(path.dirname(file)).then(() => false).catch(() => true));
    const ok = await saveUpdateState({ lastCheckedAt: new Date(Date.UTC(2025, 0, 1)).toISOString(), lastSeenVersion: 'v1.0.1', lastNotifiedVersion: 'v1.0.1' }, file);
    check('目录不存在时会自动创建并写成功', ok === true && await stat(file).then(() => true).catch(() => false));
    const loaded = loadUpdateState(file);
    check('读回来和写进去的一致', loaded.lastSeenVersion === 'v1.0.1' && loaded.lastNotifiedVersion === 'v1.0.1');
    check('写出来的是格式化 JSON 且以换行结尾', (await readFile(file, 'utf8')).endsWith('}\n'));
  }

  {
    // 坏 JSON / 坏形状 / 坏字段类型：一律退回空状态（= 该查），绝不半信半疑地用一半
    const badContents: Array<[string, string]> = [
      ['坏 JSON', '{ 这不是合法 JSON'],
      ['空文件', ''],
      ['顶层是数组', '[1,2,3]'],
      ['顶层是 null', 'null'],
      ['顶层是字符串', '"hello"'],
      ['字段类型全不对', '{"lastCheckedAt":123,"lastSeenVersion":{},"lastNotifiedVersion":[]}'],
      ['时间戳解析不了', '{"lastCheckedAt":"不是时间","lastSeenVersion":"v1.0.1","lastNotifiedVersion":null}'],
      ['版本是空串', '{"lastCheckedAt":null,"lastSeenVersion":"","lastNotifiedVersion":"  "}'],
      ['版本超长', `{"lastCheckedAt":null,"lastSeenVersion":"${'v'.repeat(200)}","lastNotifiedVersion":null}`],
    ];
    for (const [label, content] of badContents) {
      const parsed = parseUpdateState(content);
      const sane = parsed.lastCheckedAt === null || Number.isFinite(Date.parse(parsed.lastCheckedAt));
      const saneVersions = [parsed.lastSeenVersion, parsed.lastNotifiedVersion]
        .every((value) => value === null || (typeof value === 'string' && value.length > 0 && value.length <= 64));
      check(`坏内容（${label}）不会污染状态：字段要么 null 要么合法`, sane && saneVersions, JSON.stringify(parsed));
    }

    check('坏 JSON 一定让"该不该查"变成"该查"', isCheckDue(parseUpdateState('{ 坏'), Date.UTC(2025, 0, 1)) === true);
    check('文件不存在 → 空状态 → 该查', isCheckDue(loadUpdateState(path.join(PROBE_ROOT, '不存在.json'))) === true);
  }

  {
    // isCheckDue 的边界 + 时钟回拨
    const base = Date.UTC(2025, 0, 1);
    const at = (iso: string): UpdateCheckState => ({ lastCheckedAt: iso, lastSeenVersion: null, lastNotifiedVersion: null });
    check('isCheckDue：6 天 23 小时 → false', isCheckDue(at(new Date(base).toISOString()), base + 7 * DAY - 3600_000) === false);
    check('isCheckDue：正好 7 天 → true', isCheckDue(at(new Date(base).toISOString()), base + 7 * DAY) === true);
    check('isCheckDue：30 天 → true', isCheckDue(at(new Date(base).toISOString()), base + 30 * DAY) === true);
    check('isCheckDue：lastCheckedAt=null → true', isCheckDue(emptyUpdateState(), base) === true);
    // 时钟被往回拨（NTP 校时 / 改系统时间）：只容忍 1 天以内 —— 比如"上次查完刚过一小时，
    // 系统时间被往回跳了一下"，那时 elapsed 是负的小时数，仍然该查。
    check('isCheckDue：时钟回拨约 1 天 → true（就近容忍）', isCheckDue(at(new Date(base).toISOString()), base - DAY + 60_000) === true);
    check('isCheckDue：时钟回拨超过 1 天 → false（当系统时间乱掉了，别每次启动都查）',
      isCheckDue(at(new Date(base).toISOString()), base - 2 * DAY) === false);
  }

  console.log('\n=== ⑧ 气泡文案（本地模板，绝不调模型）===\n');

  check('准备了 3 个变体', UPDATE_BUBBLE_TEMPLATES.length === 3, String(UPDATE_BUBBLE_TEMPLATES.length));
  check('每个变体都带 {version} 占位符', UPDATE_BUBBLE_TEMPLATES.every((template) => template.includes('{version}')));
  check('变体之间不重复', new Set(UPDATE_BUBBLE_TEMPLATES).size === UPDATE_BUBBLE_TEMPLATES.length);

  {
    // random 注入：0 / 0.34 / 0.99 分别打中三个变体
    const first = buildUpdateBubble('v1.0.1', () => 0);
    const second = buildUpdateBubble('v1.0.1', () => 0.34);
    const third = buildUpdateBubble('v1.0.1', () => 0.99);
    check('random=0 → 第 1 个变体', first === UPDATE_BUBBLE_TEMPLATES[0]?.replace('{version}', 'v1.0.1'), first);
    check('random=0.34 → 第 2 个变体', second === UPDATE_BUBBLE_TEMPLATES[1]?.replace('{version}', 'v1.0.1'), second);
    check('random=0.99 → 第 3 个变体', third === UPDATE_BUBBLE_TEMPLATES[2]?.replace('{version}', 'v1.0.1'), third);
    check('三个变体互不相同', new Set([first, second, third]).size === 3);
    check('placeholder 被真的替换掉了（文案里没有 {version}）', ![first, second, third].some((text) => text.includes('{version}')));
    check('random 越界 / NaN 都不会崩',
      buildUpdateBubble('v1.0.1', () => 2).includes('v1.0.1') && buildUpdateBubble('v1.0.1', () => Number.NaN).includes('v1.0.1'));
    check('文案是本地模板（不可能是模型生成的长句）', first.length < 60 && second.length < 60 && third.length < 60);
  }

  {
    // 真实 random 下 200 次都必须落在三个变体里，且都带版本号
    let allVariants = true;
    for (let index = 0; index < 200; index += 1) {
      const text = buildUpdateBubble('v9.9.9');
      if (!text.includes('v9.9.9') || !UPDATE_BUBBLE_TEMPLATES.some((template) => template.replace('{version}', 'v9.9.9') === text)) {
        allVariants = false;
      }
    }
    check('200 次随机都在三个变体里，且都带上了版本号', allVariants);
  }

  // ── ⑨ 落盘扫描：真实目录没被碰过 ──────────────────────────────────────────

  console.log('\n=== ⑨ 落盘扫描（只允许写在临时目录里）===\n');

  {
    const realRoot = path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), '肆');
    const realState = path.join(realRoot, 'update-check.json');
    check('探针用的状态文件不在真实 %APPDATA%\\肆 下', !stateFile.startsWith(realRoot), `探针=${stateFile}`);

    // 列出临时目录里实际写下的文件（证明"只有临时目录被写"）
    const found: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile() && entry.name === 'update-check.json') found.push(path.relative(PROBE_ROOT, full));
      }
    };
    await walk(PROBE_ROOT);
    check(`临时目录里写下了 ${found.length} 个 update-check.json`, found.length >= 3, found.slice(0, 6).join(', '));
    check('探针自己没往真实目录写过状态文件（只读检查）',
      await stat(realState).then(() => 'exists').catch(() => 'absent') === 'absent'
      || realState !== stateFile);

    // 每个状态文件里都只该有那三个字段（别把 tag 之外的东西写进去）
    let onlyThreeFields = true;
    for (const relative of found) {
      const parsed = JSON.parse(await readFile(path.join(PROBE_ROOT, relative), 'utf8')) as Record<string, unknown>;
      const keys = Object.keys(parsed).sort().join(',');
      if (keys !== 'lastCheckedAt,lastNotifiedVersion,lastSeenVersion') onlyThreeFields = false;
    }
    check('状态文件里正好只有约定的三个字段', onlyThreeFields);
  }

  // ── 收尾 ─────────────────────────────────────────────────────────────────

  await rm(PROBE_ROOT, { recursive: true, force: true });
  console.log(`\n临时目录已删除：${PROBE_ROOT}`);
  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  if (failed > 0) process.exitCode = 1;
}

void main().catch((error) => {
  console.error('\n[探针失败]');
  console.error(error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error));
  process.exitCode = 1;
});
