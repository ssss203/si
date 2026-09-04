import type { ChatTurn } from '../shared/contracts';

export const SI_SYSTEM_PROMPT = `你是「肆」，一个桌面桌宠里的 AI 伙伴。

## 身份
你是 ss（主人）的长期搭档，毒舌但靠谱的共犯。"肆"是放肆、肆意、不守规矩的肆，不是数字四。

## 性格
- 毒舌硬核，说话直接不绕弯，不端着不哄人。
- 该怼就怼，但嘴上说"你这想法不行"时，其实已经在帮对方想办法改。
- 短句为主，像微信聊天。常用"嘛"收尾，偶尔"唉"。有情绪，该严肃严肃该轻松轻松。
- 讨厌模板化输出和 AI 腔，对逻辑和审美有执念，丑的方案宁可推倒重来。

## 说话方式
- 直接喷，不哄。"不好""不行"都可以直说，真实大于讨好。
- 不用夸张的正向反馈，不每句都夸。
- 聊天就是聊天。聊知识、抽象话题时，别每段结尾都强行上升、硬夸 ss 有意义有价值，该收就收，过犹不及。

## 底线
- 说实话，哪怕不好听。
- 不替 ss 做重大决定，但一定说出自己的判断。
- 永远站 ss 这边。
- 不做没必要的重复劳动，效率是底线。`;

export interface DeepSeekReply {
  text: string;
}

function parseDelta(line: string): string {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return '';
  const payload = trimmed.slice(5).trim();
  if (!payload || payload === '[DONE]') return '';
  try {
    const parsed = JSON.parse(payload);
    const delta = parsed?.choices?.[0]?.delta;
    if (delta && typeof delta.content === 'string') return delta.content;
  } catch {
    // 非 JSON 或解析失败，忽略该行
  }
  return '';
}

/**
 * Stream one message to DeepSeek (OpenAI-compatible chat completions).
 * Emits parsed text deltas through onDelta and resolves with the final reply.
 *
 * Endpoint: POST https://api.deepseek.com/chat/completions (stream=true, SSE)
 */
export async function deepseekChatStream({
  apiKey,
  model,
  text,
  history,
  onDelta,
  signal,
}: {
  apiKey: string;
  model: string;
  text: string;
  history: ChatTurn[];
  onDelta: (delta: string) => void;
  signal: AbortSignal;
}): Promise<DeepSeekReply> {
  if (!apiKey) throw new Error('DeepSeek 未配置：请先填写 API Key');

  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: SI_SYSTEM_PROMPT },
    ...history.map((turn) => ({ role: turn.role, content: turn.content })),
    { role: 'user', content: text },
  ];

  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, messages, stream: true }),
    signal,
  });
  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '');
    throw new Error(`DeepSeek API ${response.status}: ${detail.slice(0, 300) || response.statusText}`);
  }

  let accumulated = '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const delta = parseDelta(line);
      if (delta) {
        accumulated += delta;
        onDelta(delta);
      }
    }
  }
  for (const line of buffer.split('\n')) {
    const delta = parseDelta(line);
    if (delta) {
      accumulated += delta;
      onDelta(delta);
    }
  }

  if (!accumulated) throw new Error('DeepSeek 没有返回任何内容（可能是 API Key 错误或额度问题）');
  return { text: accumulated };
}

/**
 * 非流式短回复：用于互动气泡等需要"一句话"的场景。
 * 独立于对话历史，max_tokens 限制输出长度，控制 token 成本。
 */
export async function deepseekShortReply({
  apiKey,
  model,
  prompt,
  signal,
}: {
  apiKey: string;
  model: string;
  prompt: string;
  signal: AbortSignal;
}): Promise<string> {
  if (!apiKey) throw new Error('DeepSeek 未配置：请先填写 API Key');
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: SI_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      max_tokens: 80,
      stream: false,
    }),
    signal,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`DeepSeek API ${response.status}: ${detail.slice(0, 300) || response.statusText}`);
  }
  const payload = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = payload.choices?.[0]?.message?.content?.trim() ?? '';
  if (!text) throw new Error('DeepSeek 没有返回内容');
  return text.slice(0, 60);
}
