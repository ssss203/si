/**
 * pi-actions.ts —— 桌宠的「动作工具」（阶段 G）：让肆自己动起来。
 *
 * 你定的三条设计（这里逐条落地）：
 *   1. 【可以主动】它能在没被提问时也调用这些工具
 *   2. 【但节流】每次对话最多 3 个动作、每小时最多 6 个 —— 防止它变成烦人精
 *   3. 【能关】两处开关：
 *        · %APPDATA%\肆\coze-config.json 里 "proactiveActions": false（缺省 = 开）
 *        · 或环境变量 PET_PI_ACTIONS=off（调试用）
 *        关掉时**连工具都不注册** —— 模型根本不知道它能动
 *
 * 三个动作（打开网页按你的选择暂不做）：
 *   play_animation  播放动画（状态 id 从 pet-spec.json 动态读，加新状态不用改这里）
 *   say             主动在气泡里说一句（≤60 字）
 *   remind          安排一个提醒（写进现有提醒系统）
 *
 * 权限哲学：**不是把 shell 交出去，而是把"允许做的事"一个个显式化成工具**。
 * 每个工具的参数都是封闭的（枚举 / 数字 / 短文本），没有自由命令，也就没有注入面。
 * 等哪天真的要跑任意命令，再单独做「bash + 命令白名单 + 点确认」那一档。
 *
 * ⚠️ 老规矩：pi 和 typebox 都是纯 ESM，值导入必须用动态 import()（工厂允许 async），
 * 静态导入只留 `import type`。
 */
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/** pet-spec.json 读不到时的兜底状态表 */
const FALLBACK_STATES = ['idle', 'blink', 'happy', 'notify', 'peek', 'charge', 'music', 'pet', 'badge'];

/**
 * 节流配置：
 *   maxPerRun  —— 一次对话里最多动几次（防止模型在循环里刷动作）
 *   maxPerHour —— 一小时内最多动几次（防止它变成烦人精）
 * 刻意**不设**"两次动作之间的最小间隔"：一轮里"播个动画 + 说一句 + 排个提醒"是很自然的
 * 组合，卡间隔会误伤自己人（实测：肆被拦住后还很认真地跟主人解释了限流）。
 */
const THROTTLE = { maxPerRun: 3, maxPerHour: 6 };

/** 动作请求事件：引擎会把它透给主进程去真正执行 */
export interface ActionEvent {
  type: 'action';
  action: 'play_animation' | 'say' | 'remind';
  stateId?: string;
  text?: string;
  dueAt?: string;
}

/** 最近动作的时间戳（模块级 = 进程内共享；重启后清空，可以接受） */
const recentActions: number[] = [];

/** 本次对话里已经动了几次（每次 agent_start 归零） */
let actionsThisRun = 0;

/** 记一次成功的动作 */
function recordAction(): void {
  recentActions.push(Date.now());
  actionsThisRun += 1;
}

/** 从 pet-spec.json 动态读状态 id（加新状态不用改这个文件） */
function readStateIds(cwd: string): string[] {
  try {
    const spec = JSON.parse(readFileSync(path.join(cwd, 'pet-spec.json'), 'utf8')) as {
      states?: Array<{ id?: unknown }>;
    };
    const ids = (spec.states ?? [])
      .map((state) => (typeof state.id === 'string' ? state.id : ''))
      .filter((id) => id.length > 0);
    return ids.length > 0 ? ids : FALLBACK_STATES;
  } catch {
    return FALLBACK_STATES;
  }
}

/** 主动行为的总开关 */
function proactiveEnabled(): boolean {
  if ((process.env.PET_PI_ACTIONS ?? '').trim().toLowerCase() === 'off') return false;
  try {
    const root = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    const parsed = JSON.parse(readFileSync(path.join(root, '肆', 'coze-config.json'), 'utf8')) as {
      proactiveActions?: unknown;
    };
    // 字段缺省 = 开（和 aiBubbles 一样，属于"主动行为"类开关）
    return parsed.proactiveActions !== false;
  } catch {
    return true;
  }
}

/** 该不该拦：太频繁就告诉模型原因（它会转告主人，而不是偷偷失败） */
function throttleReason(): string | undefined {
  const now = Date.now();
  while (recentActions.length > 0 && now - (recentActions[0] as number) > 3_600_000) {
    recentActions.shift();
  }
  if (actionsThisRun >= THROTTLE.maxPerRun) {
    return `这次对话里已经动了 ${THROTTLE.maxPerRun} 次，够了吧。把动作留到下次。`;
  }
  if (recentActions.length >= THROTTLE.maxPerHour) {
    return `这一小时的动作额度用完了（上限 ${THROTTLE.maxPerHour} 次）。把机会留给更值得的时候。`;
  }
  return undefined;
}

export function createActionsExtension(options: {
  cwd: string;
  emit: (event: ActionEvent) => void;
}): (pi: ExtensionAPI) => Promise<void> {
  return async (pi: ExtensionAPI): Promise<void> => {
    // 开关关掉：连工具都不注册
    if (!proactiveEnabled()) return;

    const { defineTool } = await import('@earendil-works/pi-coding-agent');
    const { Type } = await import('typebox');
    const stateIds = readStateIds(options.cwd);
    const stateList = stateIds.join(' / ');

    // 每次对话开始把"本轮次数"清零（跨轮的每小时上限仍然累计）
    pi.on('agent_start', () => {
      actionsThisRun = 0;
    });

    const playAnimation = defineTool({
      name: 'play_animation',
      label: '播放动画',
      description: `让桌宠自己播一段动作动画。stateId 只能是：${stateList}。想表达情绪时用它（开心→happy，要提醒→notify，偷看一眼→peek，想被摸→pet）。`,
      parameters: Type.Object({
        stateId: Type.String({ description: `动画状态，必须是：${stateList}` }),
      }),
      async execute(_toolCallId, params) {
        const blocked = throttleReason();
        if (blocked !== undefined) {
          return { content: [{ type: 'text', text: `🚫 ${blocked}` }], details: { ok: false } };
        }
        const stateId = String(params.stateId);
        if (!stateIds.includes(stateId)) {
          return {
            content: [{ type: 'text', text: `没有这个状态：${stateId}。可用：${stateList}` }],
            details: { ok: false },
          };
        }
        recordAction();
        options.emit({ type: 'action', action: 'play_animation', stateId });
        return { content: [{ type: 'text', text: `已请求播放动画：${stateId}` }], details: { ok: true } };
      },
    });

    const say = defineTool({
      name: 'say',
      label: '主动说一句',
      description: '不等主人提问，主动在桌宠气泡里说一句短话（≤60 字）。想主动关心、吐槽、提醒时用它。别滥用 —— 每小时最多 4 次。',
      parameters: Type.Object({
        text: Type.String({ description: '要说的话，尽量 30 字以内' }),
      }),
      async execute(_toolCallId, params) {
        const blocked = throttleReason();
        if (blocked !== undefined) {
          return { content: [{ type: 'text', text: `🚫 ${blocked}` }], details: { ok: false } };
        }
        const text = String(params.text).slice(0, 60);
        recordAction();
        options.emit({ type: 'action', action: 'say', text });
        return { content: [{ type: 'text', text: `已在气泡里说出：「${text}」` }], details: { ok: true } };
      },
    });

    const remind = defineTool({
      name: 'remind',
      label: '安排提醒',
      description: '给主人安排一个提醒（写进桌宠的提醒系统）。inMinutes 是"多少分钟后"，最小 1 分钟。',
      parameters: Type.Object({
        text: Type.String({ description: '提醒内容' }),
        inMinutes: Type.Number({ description: '多少分钟后提醒，最小 1' }),
      }),
      async execute(_toolCallId, params) {
        const inMinutes = Math.max(1, Math.round(Number(params.inMinutes)));
        const dueAt = new Date(Date.now() + inMinutes * 60_000).toISOString();
        const text = String(params.text).slice(0, 200);
        options.emit({ type: 'action', action: 'remind', text, dueAt });
        return {
          content: [{ type: 'text', text: `已安排：${inMinutes} 分钟后提醒「${text}」` }],
          details: { ok: true },
        };
      },
    });

    pi.registerTool(playAnimation);
    pi.registerTool(say);
    pi.registerTool(remind);
  };
}
