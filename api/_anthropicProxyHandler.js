import {
  prepareConversationPayload,
  resolveApiKey,
  toNumber,
} from './_messageUtils.js';

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function mergeSystemPrompts(systemMessages) {
  return systemMessages
    .map(message => message.content?.trim())
    .filter(Boolean)
    .join('\n\n');
}

function toAnthropicContentBlock(text) {
  return [{ type: 'text', text }];
}

function normalizeConversation(messages) {
  const systemMessages = [];
  const conversation = [];

  for (const message of messages) {
    if (!message || typeof message.content !== 'string') continue;

    const trimmed = message.content.trim();
    if (!trimmed) continue;

    if (message.role === 'system') {
      systemMessages.push({ ...message, content: trimmed });
      continue;
    }

    const role = message.role === 'assistant' ? 'assistant' : 'user';

    const lastTurn = conversation[conversation.length - 1];
    if (lastTurn && lastTurn.role === role) {
      lastTurn.content[0].text += `\n${trimmed}`;
    } else {
      conversation.push({
        role,
        content: toAnthropicContentBlock(trimmed),
      });
    }
  }

  while (conversation.length && conversation[0].role !== 'user') {
    conversation.shift();
  }

  const hasUserTurn = conversation.some(turn => turn.role === 'user');
  if (!hasUserTurn) {
    throw new Error('Anthropic に渡す会話履歴にユーザーの発話が含まれていません');
  }

  return {
    systemPrompt: mergeSystemPrompts(systemMessages),
    conversation,
  };
}

function buildRequestPayload(body, normalizedMessages, options) {
  const {
    defaultModel,
    defaultTemperature,
    defaultMaxTokens,
    defaultTopP,
  } = options;

  const { systemPrompt, conversation } = normalizeConversation(normalizedMessages);

  const model = typeof body.model === 'string' && body.model.trim()
    ? body.model.trim()
    : defaultModel;

  const payload = {
    model,
    messages: conversation,
    max_tokens: toNumber(
      body.max_tokens ?? body.maxTokens ?? body.max_output_tokens ?? body.maxOutputTokens,
      defaultMaxTokens,
    ),
  };

  if (payload.max_tokens == null) {
    payload.max_tokens = defaultMaxTokens;
  }

  const temperature = toNumber(body.temperature, defaultTemperature);
  if (temperature != null) {
    payload.temperature = temperature;
  }

  const topP = toNumber(body.top_p ?? body.topP, defaultTopP);
  if (topP != null) {
    payload.top_p = topP;
  }

  const stopSequences = body.stop_sequences ?? body.stopSequences;
  if (Array.isArray(stopSequences) && stopSequences.length) {
    payload.stop_sequences = stopSequences
      .map(value => (typeof value === 'string' ? value : ''))
      .filter(Boolean);
  }

  if (systemPrompt) {
    payload.system = systemPrompt;
  }

  return payload;
}

function buildErrorResponse(options, details) {
  const { internalErrorMessage, exposeErrorDetails } = options;
  const payload = { error: internalErrorMessage };

  if (details && (exposeErrorDetails || process.env.NODE_ENV === 'development')) {
    payload.details = details;
  }

  return payload;
}

async function forwardToAnthropic(apiKey, payload, options) {
  const response = await fetch(options.apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': options.anthropicVersion,
    },
    body: JSON.stringify(payload),
  });

  let data = null;
  try {
    data = await response.json();
  } catch (error) {
    console.error('Failed to parse Anthropic response JSON:', error);
  }

  return { response, data };
}

function normalizeAnthropicResponse(data, requestPayload) {
  if (!data) return null;

  const content = Array.isArray(data.content) ? data.content : [];
  const text = content
    .map(part => {
      if (!part) return '';
      if (typeof part.text === 'string') return part.text;
      if (Array.isArray(part.content)) {
        return part.content
          .map(inner => (typeof inner?.text === 'string' ? inner.text : ''))
          .filter(Boolean)
          .join('\n');
      }
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();

  if (!text) {
    return null;
  }

  return {
    response: text,
    model: data.model ?? requestPayload.model,
    usage: data.usage,
    timestamp: new Date().toISOString(),
  };
}

function handleAnthropicError(res, status, data, options) {
  console.error('Anthropic API Error:', data);

  if (data?.error) {
    const { type, message } = data.error;
    const safeMessage = typeof message === 'string' ? message : '';

    switch (type) {
      case 'authentication_error':
        return res.status(401).json({ error: 'Anthropic APIキーが無効です。' });
      case 'permission_error':
        return res
          .status(403)
          .json({ error: 'Anthropic APIキーに必要な権限がありません。' });
      case 'rate_limit_error':
        return res
          .status(429)
          .json({
            error:
              'Anthropic APIのレート制限に達しました。しばらく待ってから再試行してください。',
          });
      case 'invalid_request_error':
        return res.status(status || 400).json({
          error: safeMessage
            ? `リクエストが無効です: ${safeMessage}`
            : 'Anthropic APIへのリクエスト内容が無効です。入力値を確認してください。',
        });
      case 'not_found_error':
        return res.status(404).json({
          error: '指定されたリソースが見つかりません。モデル名やエンドポイントを確認してください。',
        });
      default:
        return res
          .status(status || 502)
          .json(
            buildErrorResponse(options, safeMessage || `Unexpected error type: ${type}`),
          );
    }
  }

  return res.status(status || 500).json(buildErrorResponse(options));
}

export function createAnthropicProxyHandler(options = {}) {
  const handlerOptions = {
    apiUrl: 'https://api.anthropic.com/v1/messages',
    anthropicVersion: '2023-06-01',
    defaultModel: 'claude-3-haiku-20240307',
    defaultTemperature: 0.7,
    defaultMaxTokens: 1024,
    defaultTopP: undefined,
    internalErrorMessage: 'サーバー内部エラーが発生しました',
    exposeErrorDetails: false,
    ...options,
  };

  return async function handler(req, res) {
    setCorsHeaders(res);

    if (req.method === 'OPTIONS') {
      return res.status(200).end();
    }

    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    let normalized;
    try {
      normalized = prepareConversationPayload(req.body);
    } catch (error) {
      console.error('Request normalization failed:', error);
      return res.status(400).json({
        error: error.message || 'リクエスト形式が正しくありません',
      });
    }

    const body = normalized.body;
    const apiKeyCandidate = resolveApiKey(req.headers, body);
    const fallbackKey =
      typeof body.anthropicApiKey === 'string' ? body.anthropicApiKey.trim() : '';
    const apiKey = apiKeyCandidate || fallbackKey;

    if (!apiKey) {
      return res.status(400).json({ error: 'Anthropic APIキーが指定されていません' });
    }

    if (body.stream === true) {
      return res.status(400).json({ error: 'ストリーミングレスポンスには対応していません。' });
    }

    let requestPayload;
    try {
      requestPayload = buildRequestPayload(body, normalized.messages, handlerOptions);
    } catch (error) {
      console.error('Failed to build Anthropic payload:', error);
      return res.status(400).json({
        error: error.message || 'Anthropic 向けリクエストの組み立てに失敗しました',
      });
    }

    try {
      console.log('Making request to Anthropic with model:', requestPayload.model);

      const { response, data } = await forwardToAnthropic(
        apiKey,
        requestPayload,
        handlerOptions,
      );

      console.log('Anthropic response status:', response.status);

      if (!response.ok) {
        return handleAnthropicError(res, response.status, data, handlerOptions);
      }

      const normalizedResponse = normalizeAnthropicResponse(data, requestPayload);
      if (normalizedResponse) {
        return res.json(normalizedResponse);
      }

      console.error('Unexpected Anthropic response structure:', data);
      return res.status(500).json({
        error: 'Claude からの応答が空または不正な形式です',
      });
    } catch (error) {
      console.error('Anthropic Proxy Handler Error:', error);

      if (error.name === 'TypeError' && error.message.includes('fetch')) {
        return res.status(503).json({
          error:
            'Anthropic APIへの接続に失敗しました。しばらく待ってから再試行してください。',
        });
      }

      return res.status(500).json(buildErrorResponse(handlerOptions, error.message));
    }
  };
}
