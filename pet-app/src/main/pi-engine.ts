/**
 * pi-engine.ts —— 用 Pi SDK 实现桌宠的「说话引擎」。
 *
 * 对外接口与 src/main/deepseek.ts 完全一致，所以 main.ts 只需要换一行 import：
 *
 *   import {
 *     piChatStream as deepseekChatStream,
 *     piShortReply as deepseekShortReply,
 *   } from './main/pi-engine';
 *
 * 与 deepseek.ts 的关键差异（都是有意为之）：
 *
 *  1. 【常驻会话】pi 自己维护上下文，所以调用方传进来的 history 会被忽略。
 *     代价：App 重启后会话重置。
 *
 *  2. 【模型名映射】桌宠配置里写的是 deepseek-chat / deepseek-reasoner，
 *     但 pi 的模型目录里只有 deepseek-flash / deepseek-v4-pro，这里做翻译。
 *
 *  3. 【完全隔离】auth 与 agent 配置目录都指向桌宠自己的 APPDATA 目录，
 *     不依赖用户电脑上装没装 pi CLI。
 *
 *  4. 【权限逐层放开】见 TOOL_TIERS，当前是第 1 层「只读」。
 *
 * 安全与正确性边界：
 *  - 工作目录必须通过体检（同时有 package.json 和 src/main.ts）才开放工具，
 *    否则退回"只能说话"。这是路线图阶段 F 说的「工作目录边界」。
 *  - 互动气泡永远不给工具。
 *  - 会话订阅只建一次，事件只送给「当前这一轮」。
 *  - 被中止（用户点"停止"/超时）的那一轮会脏在会话记忆里 —— pi 会把没答完的
 *    那句话当成还没做完的事，在新一轮里重新做一遍（实测：被中止的"数到 200"
 *    会在下一轮的回复里重新数一遍）。所以中止后把会话标记为 dirty，
 *    下一次调用直接丢掉重开：宁可失忆，也不吐错内容。
 */
import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';
import type { ChatTurn } from '../shared/contracts';

/** Pi SDK 的类型（type-only import 会被编译期擦除，不会在运行时加载） */
type PiSdk = typeof import('@earendil-works/pi-coding-agent');

/**
 * 延迟加载 SDK。
 *
 * 为什么不在文件顶层 `import`：桌宠的主进程是 webpack 打的 CJS，而 pi 是纯 ESM
 * 包（package.json 的 exports 里只有 import 条件、没有 require）。延迟 + 动态
 * import 让打包器和运行时各按自己的规则处理，也避免顶层 await。
 */
let sdkPromise: Promise<PiSdk> | undefined;
function loadSdk(): Promise<PiSdk> {
  sdkPromise ??= import('@earendil-works/pi-coding-agent');
  return sdkPromise;
}

/** 桌宠配置里的模型名 → pi 模型目录里的 id */
const MODEL_MAP: Readonly<Record<string, string>> = {
  'deepseek-chat': 'deepseek-flash',
  'deepseek-reasoner': 'deepseek-v4-pro',
  'deepseek-flash': 'deepseek-flash',
  'deepseek-v4-pro': 'deepseek-v4-pro',
};

/**
 * 工具权限分层。一次只放开一层，跑稳了再开下一层。
 *
 *   第 1 层（当前）：read / grep / find / ls —— 只看不动
 *   第 2 层：+ edit（改文案）        ← 开之前先做「改前 git checkpoint + 撤回按钮」
 *   第 3 层：+ write（改样式/新文件）
 *   第 4 层：+ bash（改逻辑/跑测试）  ← 最后才开，且必须有命令白名单
 */
const TOOL_TIERS = {
  readOnly: ['read', 'grep', 'find', 'ls'],
} as const;

/** 桌宠专属的引擎数据目录：%APPDATA%\肆\ */
function petRoot(): string {
  return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), '肆');
}

/** 工作目录的体检结果：不通过就只让它说话。 */
interface Workspace {
  dir: string;
  allowTools: boolean;
}

/**
 * 找到"它被允许动手"的工作目录。
 *
 * 体检规则：目录里必须同时有 package.json 和 src/main.ts —— 也就是"这是一份桌宠
 * 项目源码"。这样即使 cwd 被别的程序改掉（打包后 cwd 常常不是项目目录），它也不会
 * 对着一个陌生目录乱读。
 */
function projectRoot(): Workspace {
  const candidates = [process.env.PET_PI_WORKSPACE, process.cwd()]
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  for (const dir of candidates) {
    try {
      if (existsSync(path.join(dir, 'package.json')) && existsSync(path.join(dir, 'src', 'main.ts'))) {
        return { dir, allowTools: true };
      }
    } catch {
      // 目录不可读，试下一个候选
    }
  }
  return { dir: petRoot(), allowTools: false };
}

/** 一轮对话要把事件送去哪里 */
interface RunSink {
  onDelta: (delta: string) => void;
  onEvent?: (event: { type: string; toolName?: string }) => void;
}

export interface PiChatStreamOptions {
  apiKey: string;
  model: string;
  systemPrompt: string;
  text: string;
  /** 保留参数：pi 自己维护上下文，这里不再重放历史 */
  history: ChatTurn[];
  onDelta: (delta: string) => void;
  /** 可选：工具调用等事件（UI 可以显示"正在读文件…"），不传也不影响 */
  onEvent?: (event: { type: string; toolName?: string }) => void;
  signal?: AbortSignal;
}

export interface PiReply {
  text: string;
}

export interface PiShortReplyOptions {
  apiKey: string;
  model: string;
  systemPrompt: string;
  prompt: string;
  signal?: AbortSignal;
}

/** 常驻的 ModelRuntime（模型目录 + key 的来源），整个进程共用一个 */
interface RuntimeState {
  apiKey: string;
  runtime: Awaited<ReturnType<PiSdk['ModelRuntime']['create']>>;
}
let runtimeState: RuntimeState | undefined;

async function getRuntime(apiKey: string): Promise<RuntimeState['runtime']> {
  const sdk = await loadSdk();
  if (runtimeState && runtimeState.apiKey === apiKey) return runtimeState.runtime;

  // key 换了：旧的 runtime 直接丢掉，下一次调用重新建
  runtimeState = undefined;

  const root = petRoot();
  const runtime = await sdk.ModelRuntime.create({
    // 故意不用 ~/.pi/agent：桌宠的引擎要自给自足
    authPath: path.join(root, 'pi-auth.json'),
  });
  await runtime.setRuntimeApiKey('deepseek', apiKey);
  runtimeState = { apiKey, runtime };
  return runtime;
}

/** 把调用方的 AbortSignal 桥接到 pi 的 session.abort()（pi 的 prompt 不接受 signal） */
function bridgeAbort(
  session: { abort: () => Promise<void> },
  signal: AbortSignal | undefined,
): () => void {
  if (!signal) return () => { };
  const onAbort = (): void => {
    void session.abort().catch(() => { });
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

/** 从 pi 的事件里抽出文本增量和工具名（事件是外部类型，按需窄化） */
function readEvent(event: unknown): { type: string; delta?: string; toolName?: string } {
  const typed = event as {
    type?: unknown;
    toolName?: unknown;
    assistantMessageEvent?: { type?: unknown; delta?: unknown };
  };
  const type = typeof typed.type === 'string' ? typed.type : '';
  const delta = typed.assistantMessageEvent?.type === 'text_delta'
    && typeof typed.assistantMessageEvent.delta === 'string'
    ? typed.assistantMessageEvent.delta
    : undefined;
  const toolName = typeof typed.toolName === 'string' ? typed.toolName : undefined;
  return { type, delta, toolName };
}

/** 常驻的聊天会话 */
interface ChatSession {
  key: string;
  session: Awaited<ReturnType<PiSdk['createAgentSession']>>['session'];
  /** 当前这一轮的事件出口；没有活动轮次时是 undefined（旧事件直接丢弃） */
  sink: RunSink | undefined;
  /** 这一轮是否被中止过：脏了的会话下一次调用直接丢掉重开 */
  dirty: boolean;
}
let chatSession: ChatSession | undefined;

async function disposeChatSession(): Promise<void> {
  if (!chatSession) return;
  const current = chatSession;
  chatSession = undefined;
  current.sink = undefined;
  try {
    await current.session.abort().catch(() => { });
  } catch {
    // 忽略：正要丢掉它
  }
  try {
    current.session.dispose();
  } catch {
    // 忽略：避免 dispose 的异常影响主流程
  }
}

async function getChatSession(
  apiKey: string,
  modelId: string,
  systemPrompt: string,
): Promise<ChatSession> {
  const workspace = projectRoot();
  const key = `${modelId}\u0000${systemPrompt}\u0000${workspace.dir}\u0000${workspace.allowTools}`;
  if (chatSession && chatSession.key === key && runtimeState?.apiKey === apiKey) return chatSession;

  // 模型、人设、工作目录或 key 变了 → 重建会话（原会话作废）
  await disposeChatSession();

  const sdk = await loadSdk();
  const runtime = await getRuntime(apiKey);
  const model = runtime.getModel('deepseek', modelId);
  if (!model) throw new Error(`Pi 找不到模型 deepseek/${modelId}`);

  const agentRoot = petRoot();
  const loader = new sdk.DefaultResourceLoader({
    cwd: workspace.dir,
    // 用桌宠自己的 agent 目录：不读用户 ~/.pi/agent 里的 skills / 扩展 / 设置
    agentDir: path.join(agentRoot, 'pi-agent'),
    systemPromptOverride: () => systemPrompt,
    // 必须给，否则 pi 会追加它自己的 APPEND_SYSTEM.md
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();

  const { session } = await sdk.createAgentSession({
    cwd: workspace.dir,
    model,
    modelRuntime: runtime,
    resourceLoader: loader,
    // 权限分层：体检通过才给只读工具；不通过就退回"只能说话"
    tools: workspace.allowTools ? [...TOOL_TIERS.readOnly] : [],
    sessionManager: sdk.SessionManager.inMemory(workspace.dir),
  });

  const record: ChatSession = { key, session, sink: undefined, dirty: false };

  // 订阅只建一次：事件按"当前这一轮"分发，没有活动轮次时直接丢弃。
  session.subscribe((rawEvent: unknown) => {
    if (chatSession !== record) return;
    const event = readEvent(rawEvent);
    if (event.delta !== undefined) {
      record.sink?.onDelta(event.delta);
      return;
    }
    if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end') {
      record.sink?.onEvent?.({ type: event.type, toolName: event.toolName });
    }
  });

  chatSession = record;
  return record;
}

/**
 * 流式说一句话。与 deepseekChatStream 的行为对齐：
 * 逐字通过 onDelta 回调，最后 resolve 出累计的完整文本。
 */
export async function piChatStream(options: PiChatStreamOptions): Promise<PiReply> {
  const { apiKey, model, systemPrompt, text, onDelta, onEvent, signal } = options;

  if (!apiKey) throw new Error('DeepSeek 未配置：请先填写 API Key');

  // 上一轮被中止过 → 这个会话的记忆是脏的，直接丢掉重开（见文件头说明）
  if (chatSession?.dirty) await disposeChatSession();

  const modelId = MODEL_MAP[model] ?? 'deepseek-flash';
  const active = await getChatSession(apiKey, modelId, systemPrompt);
  const { session } = active;

  let accumulated = '';
  active.sink = {
    onDelta: (delta: string) => {
      accumulated += delta;
      onDelta(delta);
    },
    onEvent,
  };

  const removeAbortBridge = bridgeAbort(session, signal);
  let completed = false;
  try {
    await session.prompt(text);
    completed = true;
  } finally {
    // 先掐断事件出口，再收尾：后面来的残留事件就进不来了
    active.sink = undefined;
    removeAbortBridge();
    if (signal?.aborted) active.dirty = true;
  }

  if (signal?.aborted) throw new Error('已中止这次回复');
  if (!completed || !accumulated) {
    throw new Error('DeepSeek 没有返回任何内容（可能是 API Key 错误或额度问题）');
  }
  return { text: accumulated };
}

/**
 * 一次性短回复（互动气泡用）：不回落到聊天上下文，单独开一个临时会话，
 * 而且【永远不给工具】—— 随口一句，不该动文件。
 * 与 deepseekShortReply 对齐：返回一句话，且最多 60 个字符。
 */
export async function piShortReply(options: PiShortReplyOptions): Promise<string> {
  const { apiKey, model, systemPrompt, prompt, signal } = options;

  if (!apiKey) throw new Error('DeepSeek 未配置：请先填写 API Key');

  const sdk = await loadSdk();
  const runtime = await getRuntime(apiKey);
  const modelId = MODEL_MAP[model] ?? 'deepseek-flash';
  const resolved = runtime.getModel('deepseek', modelId) ?? runtime.getModel('deepseek', 'deepseek-flash');
  if (!resolved) throw new Error('Pi 模型目录里找不到 deepseek-flash');

  const agentRoot = petRoot();
  const loader = new sdk.DefaultResourceLoader({
    cwd: agentRoot,
    agentDir: path.join(agentRoot, 'pi-agent'),
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();

  const { session } = await sdk.createAgentSession({
    cwd: agentRoot,
    model: resolved,
    modelRuntime: runtime,
    resourceLoader: loader,
    tools: [],
    sessionManager: sdk.SessionManager.inMemory(agentRoot),
  });

  let accumulated = '';
  const unsubscribe = session.subscribe((rawEvent: unknown) => {
    const event = readEvent(rawEvent);
    if (event.delta !== undefined) accumulated += event.delta;
  });

  const removeAbortBridge = bridgeAbort(session, signal);
  try {
    await session.prompt(prompt);
  } finally {
    removeAbortBridge();
    if (typeof unsubscribe === 'function') unsubscribe();
    session.dispose();
  }

  const trimmed = accumulated.trim();
  if (!trimmed) throw new Error('DeepSeek 没有返回内容');
  return trimmed.slice(0, 60);
}

/**
 * 主动重置聊天会话：桌宠 UI 里"清空对话"时应该调它，
 * 否则 pi 还会记得清空之前的上下文。
 */
export async function resetPiChatSession(): Promise<void> {
  await disposeChatSession();
}

/** 给探针/诊断用：当前它会用哪个工作目录、开不开工具 */
export function describeWorkspace(): Workspace & { tools: readonly string[] } {
  const workspace = projectRoot();
  return { ...workspace, tools: workspace.allowTools ? [...TOOL_TIERS.readOnly] : [] };
}

// TODO(下一步)：
//  - 第 2 层：开 edit 之前，先做「改前自动 git checkpoint + UI 撤回按钮」
//  - 第 3/4 层：write / bash 逐层放开，配合命令白名单和 protected paths
//  - App 重启后把历史对话重放进 pi 会话（或用 SessionManager.create + sessionFile 持久化）
