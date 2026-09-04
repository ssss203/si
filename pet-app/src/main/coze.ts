import { randomUUID } from 'node:crypto';

export interface CozeReply {
  text: string;
  audioUrl?: string;
}

interface CozeSseEvent {
  id: string;
  event: string;
  data?: unknown;
}

function parseSseChunk(chunk: string): CozeSseEvent[] {
  const events: CozeSseEvent[] = [];
  for (const block of chunk.split('\n\n')) {
    let id = '';
    let event = '';
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('id:')) id = line.slice(3).trim();
      else if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (!event && dataLines.length === 0) continue;
    let data: unknown;
    try {
      data = dataLines.length ? JSON.parse(dataLines.join('\n')) : undefined;
    } catch {
      data = dataLines.join('\n');
    }
    events.push({ id, event: event || 'message', data });
  }
  return events;
}

/**
 * Stream one message to a Coze bot. Emits parsed text deltas through onDelta
 * and resolves with the final assistant reply.
 *
 * Endpoint: POST https://api.coze.cn/v3/chat (stream=true, SSE)
 */
export async function cozeChatStream({
  apiToken,
  botId,
  userId,
  text,
  onDelta,
  signal,
}: {
  apiToken: string;
  botId: string;
  userId: string;
  text: string;
  onDelta: (delta: string) => void;
  signal: AbortSignal;
}): Promise<CozeReply> {
  if (!apiToken || !botId) throw new Error('Coze 未配置：请先填写 API Token 和 Bot ID');
  const response = await fetch('https://api.coze.cn/v3/chat', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      bot_id: botId,
      user_id: userId,
      stream: true,
      auto_save_history: true,
      additional_messages: [
        { role: 'user', content: text, content_type: 'text' },
      ],
    }),
    signal,
  });
  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Coze API ${response.status}: ${detail.slice(0, 300) || response.statusText}`);
  }

  let accumulated = '';
  let audioUrl: string | undefined;

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // Process complete SSE blocks only.
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() ?? '';
    for (const block of blocks) {
      for (const event of parseSseChunk(block)) {
        const data = event.data as { type?: string; content?: string; audio?: string } | undefined;
        if (event.event === 'conversation.message.delta' && typeof data?.content === 'string') {
          accumulated += data.content;
          onDelta(data.content);
        } else if (event.event === 'conversation.message.completed' && typeof data?.content === 'string' && data.type === 'answer') {
          accumulated = data.content;
        } else if (event.event === 'conversation.audio.delta' && typeof data?.audio === 'string') {
          audioUrl = audioUrl ? audioUrl : data.audio;
        }
      }
    }
  }
  if (!accumulated) throw new Error('Coze 没有返回任何内容（可能是 Token/Bot ID 配置错误或额度问题）');
  return { text: accumulated, audioUrl };
}

export function defaultCozeUserId(): string {
  return `si-pet-${randomUUID().slice(0, 8)}`;
}
