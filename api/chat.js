import { createOpenAIProxyHandler } from './_openaiProxyHandler.js';

/**
 * `/api/chat` は旧フロントエンドから利用されることを想定したレガシー API です。
 * 実際のロジックは `_openaiProxyHandler` に集約されており、ここでは互換性維持のために
 * 必要最小限のオプションだけを指定します。
 *
 * - exposeErrorDetails: true を指定することで、従来通り詳細なエラー内容を返し、
 *   旧クライアントが期待する挙動を保ちます。
 */
export default createOpenAIProxyHandler({
  exposeErrorDetails: true,
});
