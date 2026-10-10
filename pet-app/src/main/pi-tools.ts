/**
 * pi-tools.ts —— 给桌宠注册的**自定义工具**（阶段 F 的测试安全网 + 阶段 G 的机制）。
 *
 * 第一个工具 `run_checks`：固定运行项目的 `npm run check`
 *   （类型检查 + 开发契约 + 规格校验 + 资源链接 + UI/体验/素材 QA）
 *
 * 为什么不用 bash 来跑：
 *   bash 能执行任意命令，安全面太大（要额外做命令白名单）。
 *   固定命令的工具 = 参数里没有自由文本 = 没有命令注入面。
 *   这也正是阶段 G「动作工具」的同一套机制：把"允许它做的事"做成一个个明确的工具，
 *   而不是把一整个 shell 交给它。
 *
 * ⚠️ 这个文件里有一条硬规矩（踩过两次的坑）：
 *   `@earendil-works/pi-coding-agent` 和 `typebox` 都是**纯 ESM**（package.json 的 exports
 *   里只有 import 条件、没有 require）。而桌宠主进程是 webpack 打的 CJS、探测脚本走 tsx 的
 *   CJS —— 只要用**静态值导入**（`import { defineTool } from ...`），运行时就会变成
 *   require(ESM) → ERR_PACKAGE_PATH_NOT_EXPORTED。
 *   所以：值一律用动态 `import()` 拿（工厂允许 async），静态导入只留 `import type`（编译期擦除）。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const execFileAsync = promisify(execFile);

interface RunResult {
  ok: boolean;
  text: string;
}

/**
 * 跑一条**固定**命令（命令由代码写死，不接受模型传进来的自由文本）。
 * shell: true 是为了让 Windows 能解析 npm；因为命令全是我们写死的常量、
 * 没有拼接任何外部输入，所以不引入命令注入面。
 */
async function runFixed(cwd: string, command: string, timeoutMs: number): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync(command, {
      cwd,
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      shell: true,
    });
    return { ok: true, text: `${stdout}${stderr}`.trim() };
  } catch (error) {
    const typed = error as { stdout?: string; stderr?: string; message?: string };
    const text = `${typed.stdout ?? ''}${typed.stderr ?? ''}`.trim();
    return { ok: false, text: text || typed.message || String(error) };
  }
}

/** 输出太长就只留尾巴（模型的上下文很贵） */
function tail(text: string, max = 3000): string {
  return text.length <= max ? text : `…（前面省略 ${text.length - max} 字）\n${text.slice(-max)}`;
}

export function createProjectToolsExtension(options: { cwd: string }): (pi: ExtensionAPI) => Promise<void> {
  return async (pi: ExtensionAPI): Promise<void> => {
    // 动态导入 ESM-only 的包（原因见文件头）
    const { defineTool } = await import('@earendil-works/pi-coding-agent');
    const { Type } = await import('typebox');

    const runChecks = defineTool({
      name: 'run_checks',
      label: '跑项目自检',
      description: '运行项目的完整自检（npm run check）。你改完任何代码之后都必须调用它来验证，不要凭感觉说"改好了"—— 绿灯才算数。',
      parameters: Type.Object({}),
      async execute() {
        const result = await runFixed(options.cwd, 'npm run check', 300000);
        return {
          content: [{
            type: 'text',
            text: `${result.ok ? '✅ 自检通过（exit 0）' : '❌ 自检失败（exit ≠ 0）'}\n\n${tail(result.text)}`,
          }],
          details: { ok: result.ok },
        };
      },
    });

    const gitStatus = defineTool({
      name: 'git_status',
      label: '看改动',
      description: '显示当前工作区改了哪些文件，以及最近 5 条提交。想确认"我到底动了什么"时用它。',
      parameters: Type.Object({}),
      async execute() {
        const status = await runFixed(options.cwd, 'git status --short', 30000);
        const log = await runFixed(options.cwd, 'git log --oneline -5', 30000);
        return {
          content: [{
            type: 'text',
            text: `工作区改动：\n${status.text || '(干净)'}\n\n最近提交：\n${log.text || '(无)'}`,
          }],
          details: {},
        };
      },
    });

    pi.registerTool(runChecks);
    pi.registerTool(gitStatus);
  };
}
