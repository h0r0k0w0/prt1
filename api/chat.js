import { createOpenAIProxyHandler } from './_openaiProxyHandler.js';

// Legacy endpoint kept for backwards compatibility with older clients that
// expect /api/chat. The actual implementation is shared with openai-proxy so
// both routes behave identically.
export default createOpenAIProxyHandler({
  // Preserve the original behaviour of exposing detailed error messages when
  // something goes wrong server-side.
  exposeErrorDetails: true,
});
