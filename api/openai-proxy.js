import { createOpenAIProxyHandler } from './_openaiProxyHandler.js';

/**
 * `/api/openai-proxy` は現在のフロントエンドが利用するメインの API です。
 * `_openaiProxyHandler` をそのまま利用しつつ、応答の多様性を調整するためのペナルティや
 * 本番向けのエラーメッセージ設定をここで上書きしています。
 *
 * - exposeErrorDetails: false とすることで、ユーザーに内部情報を漏らさず安全な文言を返します。
 */
export default createOpenAIProxyHandler({
  exposeErrorDetails: false,
  internalErrorMessage: 'サーバー内部エラーが発生しました。管理者に連絡してください。',
});
