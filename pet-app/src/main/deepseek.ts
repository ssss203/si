/**
 * deepseek.ts —— 桌宠「说话引擎」的入口（开关文件）。
 *
 * 这个文件现在只有一行有效代码：把真正的实现 re-export 出去。
 *
 * 为什么这么设计：
 *   main.ts 里那句 import 从头到尾没有变过 ——
 *     import { deepseekChatStream, deepseekShortReply } from './main/deepseek';
 *   而 src/main.ts 被 .pet-builder.json 的哈希锁保护着（改了它，npm run doctor
 *   和打包前的 preflight 都会拦住构建）。把"换引擎"这件事收在这个不受保护的
 *   文件里，受保护的模板文件就零漂移，构建也不会被打断。
 *
 * 两套实现随时可切：
 *   ./pi-engine      Pi SDK 会话（新引擎，阶段 C 起默认）
 *   ./deepseek-http  原来的 DeepSeek HTTP + SSE 直连（保底实现，完整保留）
 *
 * 回滚方法：把下面这块换成文件末尾注释里那一版，然后跑 npx tsc --noEmit && npm run check。
 */
export {
  piChatStream as deepseekChatStream,
  piShortReply as deepseekShortReply,
} from './pi-engine';

/* ---- 想切回原来的直连 HTTP 引擎，就把上面那块注释掉，放开下面这块 ----

export { deepseekChatStream, deepseekShortReply } from './deepseek-http';

---- */
