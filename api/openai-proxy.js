import { createOpenAIProxyHandler } from './_openaiProxyHandler.js';

// Primary endpoint used by the front-end. Shares implementation with chat.js
// but tweaks default penalty behaviour and hides internal error details in
// production responses.
export default createOpenAIProxyHandler({
  defaultPresencePenalty: 0.1,
  defaultFrequencyPenalty: 0.1,
  exposeErrorDetails: false,
  internalErrorMessage: 'サーバー内部エラーが発生しました。管理者に連絡してください。',
});
