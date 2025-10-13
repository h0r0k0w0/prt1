import { createAnthropicProxyHandler } from './_anthropicProxyHandler.js';

/**
 * `/api/claude-proxy` は Anthropic Claude モデルへの呼び出しをサーバー経由で仲介します。
 * OpenAI プロキシと同様に `_messageUtils` を用いて履歴を正規化し、Anthropic API の仕様に合わせた
 * リクエストへ変換したうえで `https://api.anthropic.com/v1/messages` へ転送します。
 */
export default createAnthropicProxyHandler({
  defaultModel: 'claude-3-haiku-20240307',
  defaultTemperature: 0.6,
  defaultMaxTokens: 1024,
  internalErrorMessage:
    'サーバー内部エラーが発生しました。管理者に連絡してください。',
});
