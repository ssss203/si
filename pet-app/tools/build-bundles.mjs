// 生产用 webpack 编译：产出 electron-builder 能直接打包的 .webpack/prod 目录。
//
// 为什么不用 `electron-forge package`：Forge 那条线（@electron/packager）在本机
// Node 24.16 上"解压 Electron"阶段静默退出（exit 0），什么都不产出。这里只借 webpack
// 把源码编译成"已编译好的应用"，再由 electron-builder 负责下载/组装 Electron 运行时。
//
// 目录布局刻意和 Forge 的 plugin-webpack **生产模式**保持一致（见
// node_modules/@electron-forge/plugin-webpack/dist/WebpackConfig.js）：
//
//   .webpack/prod/main/index.js                       主进程
//   .webpack/prod/main/<chunk>.index.js               主进程懒加载 chunk
//   .webpack/prod/renderer/<name>/index.js            渲染层
//   .webpack/prod/renderer/<name>/preload.js          预加载
//   .webpack/prod/renderer/<name>/index.html          HTML
//   .webpack/prod/renderer/<name>/index.css           样式
//
// 这样 main.ts 里 Forge 注入的 define 语义可以原样复刻：
//   require('path').resolve(__dirname, '../renderer/<name>/index.html' | 'preload.js')
// 于是 electron-builder 只要把 .webpack/prod 的**内容**当作 app 根目录即可。
//
// 注意：不依赖 webpack-cli（本工程没装），全程走 webpack 的 Node API。

import { copyFile, mkdir, readFile, rename, rm, writeFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const outRoot = path.join(root, '.webpack', 'prod');

/** 移动文件；源不存在就算了（.css.map 在关闭 source map 时不会生成） */
async function renameFileIfExists(source, target) {
  try {
    await rename(source, target);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

// ── 1. 入口点清单：和 forge.config.js 的 renderer.entryPoints 一一对应 ──────────
const entryPoints = [
  { name: 'pet_window', html: './src/renderer/pet/index.html', js: './src/renderer/pet/index.ts' },
  { name: 'reminder_window', html: './src/renderer/reminder/index.html', js: './src/renderer/reminder/index.ts' },
  { name: 'dashboard_window', html: './src/renderer/dashboard/index.html', js: './src/renderer/dashboard/index.ts' },
  { name: 'call_window', html: './src/renderer/call/index.html', js: './src/renderer/call/index.ts' },
  { name: 'approval_window', html: './src/renderer/approval/index.html', js: './src/renderer/approval/index.ts' },
];
const preloadEntry = './src/preload.ts';

/** 相对入口文件写；webpack 5 的 entry 接受 './x'，省得再纠结 Windows 反斜杠 */
function fromRoot(relative) {
  return `./${relative.replace(/^\.\//, '')}`;
}

/** define 键名规则：Forge 的 toEnvironmentVariable（大写 + _WEBPACK_ENTRY 后缀） */
function toDefineName(name, preload = false) {
  return `${name.toUpperCase().replace(/ /g, '_')}${preload ? '_PRELOAD_WEBPACK_ENTRY' : '_WEBPACK_ENTRY'}`;
}

/**
 * 主进程 define：生产模式下 Forge 注入的是**运行时代码**，
 * 靠 __dirname 反推 renderer 目录（这里 __dirname = .../.webpack/prod/main）。
 *
 * 用字符串拼接而不是模板字面量：DefinePlugin 是纯文本替换，
 * 替换值里出现 `${` 会被 webpack 解析成外层模板字面量的插值，直接把产物写坏。
 */
function mainDefines() {
  const defines = {};
  for (const entry of entryPoints) {
    const url = `'file://' + require('path').resolve(__dirname, '..', 'renderer', '${entry.name}', 'index.html')`;
    const preload = `require('path').resolve(__dirname, '..', 'renderer', '${entry.name}', 'preload.js')`;
    defines[toDefineName(entry.name)] = url;
    defines[toDefineName(entry.name, true)] = preload;
    // Forge 同时把同样的值挂到 process.env.* 上，保持兼容
    defines[`process.env.${toDefineName(entry.name)}`] = url;
    defines[`process.env.${toDefineName(entry.name, true)}`] = preload;
  }
  return defines;
}

/** 把已经解析好的绝对路径强行接到目标输出目录下（覆盖 renderer 配置里相对 cwd 的解析） */
class RedirectOutputPathPlugin {
  constructor(directory) {
    this.directory = directory;
  }

  apply(compiler) {
    compiler.hooks.beforeCompile.tap('RedirectOutputPathPlugin', () => {
      compiler.options.output.path = this.directory;
    });
  }
}

/**
 * 渲染层配置里的 MiniCssExtractPlugin 是单例，filename 写死 '[name].css'，
 * 于是 CSS 落在 renderer/ 根目录，而 HTML 在 renderer/<name>/index.html 里按相对路径
 * 引用它 —— 指向 renderer/<name>/<name>.css，打包后必然 404（白屏无样式）。
 *
 * 改插件 options 不可行：MiniCssExtractPlugin 的内部 options 里没有 filename/chunkFilename
 * 直接属性，实例被 webpack 缓存。所以这里在编译后做一次确定性的搬运：
 *   1. 把根目录的 <name>.css / .css.map 移到 renderer/<name>/index.css
 *   2. 重写 HTML 里对应的 <link href>
 * 全部按 entryPoints 精确匹配，不猜。
 */
async function relocateRendererCss() {
  const rendererDir = path.join(outRoot, 'renderer');
  const moved = [];
  for (const entry of entryPoints) {
    const htmlFile = path.join(rendererDir, entry.name, 'index.html');
    const source = path.join(rendererDir, `${entry.name}.css`);
    let html = await readFile(htmlFile, 'utf8');
    const hasLink = html.includes(`href="${entry.name}.css"`);
    if (!hasLink) continue;
    let exists = true;
    try {
      await stat(source);
    } catch {
      exists = false;
    }
    if (!exists) throw new Error(`${entry.name}.css 被 HTML 引用但文件不存在：${source}`);
    await rename(source, path.join(rendererDir, entry.name, 'index.css'));
    await renameFileIfExists(`${source}.map`, path.join(rendererDir, entry.name, 'index.css.map'));
    html = html.replaceAll(`href="${entry.name}.css"`, `href="${entry.name}/index.css"`);
    await writeFile(htmlFile, html, 'utf8');
    moved.push(entry.name);
  }
  if (moved.length) console.log(`[css] 已把 ${moved.length} 个样式表移进各自的渲染目录：${moved.join(', ')}`);
}

/** 打印编译结果（webpack 的 errors 默认不会让进程非零退出，必须自己抛） */
function reportStats(label, stats) {
  const info = stats.toJson({ all: false, errors: true, warnings: true, assets: true, timings: true });
  for (const warning of info.warnings ?? []) {
    console.warn(`[${label}] warning: ${warning.message ?? warning}`);
  }
  for (const error of info.errors ?? []) {
    console.error(`[${label}] error: ${error.message ?? error}`);
  }
  if (stats.hasErrors()) throw new Error(`${label} 编译失败`);
  const size = (info.assets ?? []).reduce((total, asset) => total + (asset.size ?? 0), 0);
  console.log(`[${label}] ok assets=${(info.assets ?? []).length} size=${(size / 1024).toFixed(1)}KiB time=${info.time}ms`);
}

async function compile(webpack, config) {
  const stats = await new Promise((resolve, reject) => {
    webpack(config, (error, result) => (error ? reject(error) : resolve(result)));
  });
  reportStats(config.name, stats);
}

// ── 2. 三个 webpack 配置：main / renderer / preload ───────────────────────────

function mainConfig(webpack, projectConfig) {
  const outputPath = path.join(outRoot, 'main');
  return {
    // 合并项目自己的 webpack.main.config.js（externals、loader、ts 规则都在里面）
    ...projectConfig,
    name: 'main',
    mode: 'production',
    target: 'electron-main',
    devtool: 'source-map',
    entry: fromRoot('src/main.ts'),
    output: {
      path: outputPath,
      filename: 'index.js',
      libraryTarget: 'commonjs2',
      // ⚠️ 不要写 publicPath: ''。空字符串在 webpack 里是"运行时自动推断"，
      // 渲染层会拿 document.currentScript.src 当基准，而 HTML 又是**相对路径**引用
      // index.js —— 两者相乘会得到 renderer/<name>/<name>/index.js（实测 404，
      // 渲染层整个不执行，产物看起来"活了"但永远到不了 runtime-ready）。
      // 主进程没有这一层问题（它用 __dirname），这里保持默认即可。
      // electron-main 的默认假设里 dynamicImport 是关的，但 Electron 37 的主进程就是 Node 22：
      // CJS 里 import() 合法（pi 的 external 正需要它）。项目原配置也有这一条，
      // 这里在 output 里显式再写一遍 —— environment 是 output 的子项，改 output 时别弄丢。
      environment: { dynamicImport: true },
    },
    // 主进程里 __dirname 必须是真实目录（main.ts 用 path.resolve(__dirname, trayIconPath)）
    node: { __dirname: false, __filename: false },
    plugins: [
      ...(projectConfig.plugins ?? []),
      new webpack.DefinePlugin(mainDefines()),
      new RedirectOutputPathPlugin(outputPath),
    ],
  };
}

function rendererConfig(webpack, HtmlWebpackPlugin, projectConfig, entry) {
  return {
    ...projectConfig,
    name: `renderer:${entry.name}`,
    mode: 'production',
    target: 'web',
    devtool: 'source-map',
    entry: { [entry.name]: fromRoot(entry.js) },
    output: {
      path: path.join(outRoot, 'renderer'),
      filename: '[name]/index.js',
      globalObject: 'self',
      // ⚠️ publicPath 必须保持默认（'auto'），千万不要写 '/' 或 ''：
      //   · '/' → HTML 变成 src="/pet_window/index.js"；file:// 下根目录是盘符根，
      //           实际去 F:\pet_window\index.js 找 → 加载失败，渲染层不执行
      //   · ''  → 等价于"自动推断"，实测会得到 <name>/<name>/index.js（双目录，404）
      //   · 默认 → HTML 用相对路径 src="pet_window/index.js"，webpack 运行时从
      //           document.currentScript.src 推出 renderer/ 当基准，两者一致
      // （Forge 生产模式也是默认，见 plugin-webpack 的 buildRendererBaseConfig）
    },
    plugins: [
      ...(projectConfig.plugins ?? []),
      new HtmlWebpackPlugin({
        title: entry.name,
        template: fromRoot(entry.html),
        filename: `${entry.name}/index.html`,
        chunks: [entry.name],
      }),
      new RedirectOutputPathPlugin(path.join(outRoot, 'renderer')),
    ],
  };
}

function preloadConfig(webpack, projectConfig) {
  const entry = {};
  for (const item of entryPoints) entry[item.name] = fromRoot(preloadEntry);
  return {
    ...projectConfig,
    name: 'preload',
    mode: 'production',
    // sandbox: true 的预加载必须用 electron-preload 目标（Forge 的原话）
    target: 'electron-preload',
    devtool: 'source-map',
    entry,
    output: {
      path: path.join(outRoot, 'renderer'),
      filename: '[name]/preload.js',
      globalObject: 'self',
    },
    plugins: [
      ...(projectConfig.plugins ?? []),
      // 沙箱预加载里 Node 内置模块不可用，必须外置（和 Forge 一致）
      new webpack.ExternalsPlugin('commonjs2', ['electron', 'electron/renderer', 'electron/common', 'events', 'timers', 'url']),
      new RedirectOutputPathPlugin(path.join(outRoot, 'renderer')),
    ],
  };
}

// ── 3. 收尾：写一个最小 package.json，并打印产物清单 ──────────────────────────

/**
 * electron-builder 需要一个 package.json 来决定 name/productName/version/main。
 * 这里**不复制**工程的 package.json —— 那是受保护文件，而且带着 scripts/devDependencies。
 * 只写打包真正需要的字段，main 指向编译产物（相对 app 根目录）。
 */
async function writeAppManifest() {
  const spec = JSON.parse(await readFile(path.join(root, 'pet-spec.json'), 'utf8'));
  const manifest = {
    name: 'com-si-pet',
    productName: spec.app.name,
    version: spec.app.version,
    description: 'Secure cross-platform Electron desktop pet',
    main: 'main/index.js',
    author: 'Desktop Pet Builder User',
    license: 'UNLICENSED',
  };
  await writeFile(path.join(outRoot, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`[app] package.json main=${manifest.main} productName=${manifest.productName} version=${manifest.version}`);
}

/**
 * 运行时**外部资源**（不在 webpack 图里，靠 app.getAppPath()/__dirname 找）：
 *
 *   role-card.json   main.ts loadRoleCard → app.getAppPath()/role-card.json
 *   pet-spec.json    pi-tools.ts 读 states（main bundle 里已内联一份，这里留文件便于核对）
 *   tools/foreground-window.ps1
 *                     pi-companion.ts foregroundScriptPath() 的第二个候选是
 *                     __dirname/../../tools/… = resources/tools/…，
 *                     但 __dirname 在打包后是 resources/app/main，
 *                     所以真正能命中的位置是 resources/app/tools/…
 *
 * 这些文件**必须**由这里放进 app 目录：实测把它们写进 electron-builder.yml 的 files
 * 列表并不会进入产物（app 目录被 electron-builder 的 node_modules 收集逻辑接管），
 * 所以"能编译出来"和"打包后还在"是两件事，这里显式复制 + 复制后校验。
 */
const runtimeResources = [
  { from: 'role-card.json', to: 'role-card.json' },
  { from: 'pet-spec.json', to: 'pet-spec.json' },
  { from: path.join('tools', 'foreground-window.ps1'), to: path.join('tools', 'foreground-window.ps1') },
];

async function copyRuntimeResources() {
  for (const resource of runtimeResources) {
    const source = path.join(root, resource.from);
    const target = path.join(outRoot, resource.to);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
  }
  console.log(`[resources] 已复制 ${runtimeResources.length} 个运行时外部资源（role-card / pet-spec / foreground-window.ps1）`);
}

/** 复制完再验一遍：缺一个都会让某个功能静默降级 */
async function verifyRuntimeResources() {
  const missing = [];
  for (const resource of runtimeResources) {
    try {
      await stat(path.join(outRoot, resource.to));
    } catch {
      missing.push(resource.to);
    }
  }
  if (missing.length) throw new Error(`运行时外部资源缺失：\n${missing.join('\n')}`);
  console.log('[verify] 运行时外部资源齐全');
}

/** 逐个检查 HTML 里引用的相对资源真的存在（少一个文件 = 打包后白屏） */
async function verifyHtmlReferences() {
  const rendererDir = path.join(outRoot, 'renderer');
  const missing = [];
  for (const entry of entryPoints) {
    const htmlFile = path.join(rendererDir, entry.name, 'index.html');
    const html = await readFile(htmlFile, 'utf8');
    for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
      const reference = match[1];
      if (/^([a-z]+:)?\/\//i.test(reference) || reference.startsWith('data:')) continue;
      // HtmlWebpackPlugin 生成的是相对 HTML 的引用（如 '../pet_window/index.js'），
      // 所以基准是 HTML 自己所在的 renderer/<name>/ 目录
      try {
        await stat(path.join(rendererDir, entry.name, reference));
      } catch {
        missing.push(`${entry.name}/index.html -> ${reference}`);
      }
    }
  }
  if (missing.length) throw new Error(`HTML 引用的资源缺失：\n${missing.join('\n')}`);
  console.log(`[verify] ${entryPoints.length} 个 index.html 的脚本/样式引用全部存在`);
}

async function summarize(directory) {
  let files = 0;
  let bytes = 0;
  async function walk(current) {
    for (const item of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, item.name);
      if (item.isDirectory()) await walk(full);
      else {
        files += 1;
        bytes += (await stat(full)).size;
      }
    }
  }
  await walk(directory);
  console.log(`[bundle] ${path.relative(root, directory)}: ${files} 个文件, ${(bytes / 1024 / 1024).toFixed(2)}MiB`);
}

// ── 4. 入口 ───────────────────────────────────────────────────────────────────

async function loadWebpack() {
  try {
    // webpack 是 CJS 包，用动态 import 拿默认导出（和本工程其它 mjs 工具一致）
    const imported = await import('webpack');
    return imported.default ?? imported;
  } catch (error) {
    throw new Error(`webpack 不可用（本工程只用 Node API，不依赖 webpack-cli）：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function loadProjectConfig(file) {
  // 项目里的 webpack 配置是 .js（CJS）；用 createRequire 加载最稳
  const { createRequire } = await import('node:module');
  const projectRequire = createRequire(path.join(root, 'package.json'));
  const loaded = projectRequire(path.resolve(root, file));
  return loaded && typeof loaded === 'object' && 'default' in loaded ? loaded.default : loaded;
}

async function main() {
  const webpack = await loadWebpack();
  const HtmlWebpackPlugin = (await import('html-webpack-plugin')).default;
  const mainProject = await loadProjectConfig('webpack.main.config.js');
  const rendererProject = await loadProjectConfig('webpack.renderer.config.js');

  console.log(`[clean] ${path.relative(root, outRoot)}`);
  await rm(outRoot, { recursive: true, force: true });
  await mkdir(path.join(outRoot, 'main'), { recursive: true });
  await mkdir(path.join(outRoot, 'renderer'), { recursive: true });

  const configs = [
    mainConfig(webpack, mainProject),
    ...entryPoints.map((entry) => rendererConfig(webpack, HtmlWebpackPlugin, rendererProject, entry)),
    preloadConfig(webpack, rendererProject),
  ];
  for (const config of configs) await compile(webpack, config);

  await writeAppManifest();
  await copyRuntimeResources();
  await verifyRuntimeResources();
  await relocateRendererCss();
  await verifyHtmlReferences();
  await summarize(outRoot);
  console.log('BUNDLES_READY out=.webpack/prod');
}

main().catch((error) => {
  console.error(`BUILD_BUNDLES_FAILED: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
