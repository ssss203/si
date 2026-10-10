module.exports = {
  entry: './src/main.ts',
  target: 'electron-main',
  devtool: 'source-map',
  output: {
    // electron-main 的默认假设里 dynamicImport 是关的，但 Electron 37 的主进程
    // 就是 Node 22：CJS 文件里用 import() 完全合法（pi 的 external 正需要它）。
    // 告诉 webpack 真相，否则它会报 "target environment doesn't support 'import()'"。
    environment: { dynamicImport: true },
  },
  module: {
    rules: [
      { test: /\.tsx?$/, exclude: /node_modules/, use: [{ loader: 'ts-loader' }] },
      { test: /\.png$/i, type: 'asset/resource' },
    ],
  },
  resolve: { extensions: ['.ts', '.tsx', '.js', '.json'] },
  externals: {
    'uiohook-napi': 'commonjs2 uiohook-napi',
    // Pi SDK 是纯 ESM 包，而且带着 quickjs.wasm / pi-tui 的 .node 原生资产。
    // 让 webpack 去打包它会有两个麻烦：① .wasm 会被当成 JS 模块解析直接报错
    // ② 里面的 import.meta.url / createRequire 在 CJS 产物里语义会变。
    // 所以标记成 import 型 external：构建时跳过，运行时由 Node/Electron 用
    // 它自己的 ESM 规则加载（dev 模式下 node_modules 就在旁边，直接可用）。
    // 打包成安装包时要处理的事见阶段 H（asarUnpack .node/.wasm）。
    '@earendil-works/pi-coding-agent': 'import @earendil-works/pi-coding-agent',
  },
};
