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

function extractModelName(body, fallbackModel) {
  if (typeof body.model === 'string' && body.model.trim()) {
    return body.model.trim();
  }
  return fallbackModel;
}

function buildRequestPayload(body, normalizedMessages, options) {
  const {
    defaultModel,
    defaultTemperature,
    defaultPresencePenalty,
    defaultFrequencyPenalty,
    defaultMaxTokens,
    defaultMaxCompletionTokens,
  } = options;

  const model = extractModelName(body, defaultModel);
  const temperature = toNumber(body.temperature, defaultTemperature);

  const payload = {
    model,
    messages: normalizedMessages,
    temperature,
  };

  if (body.max_completion_tokens != null) {
    payload.max_completion_tokens = toNumber(
      body.max_completion_tokens,
      defaultMaxCompletionTokens,
    );
  } else {
    const providedMax = body.maxTokens ?? body.max_tokens ?? defaultMaxTokens;
    if (providedMax != null) {
      payload.max_tokens = toNumber(providedMax, defaultMaxTokens);
    }
  }

  const presencePenalty =
    body.presence_penalty ?? defaultPresencePenalty ?? null;
  if (presencePenalty != null) {
    payload.presence_penalty = toNumber(
      presencePenalty,
      defaultPresencePenalty ?? 0,
    );
  }

  const frequencyPenalty =
    body.frequency_penalty ?? defaultFrequencyPenalty ?? null;
  if (frequencyPenalty != null) {
    payload.frequency_penalty = toNumber(
      frequencyPenalty,
      defaultFrequencyPenalty ?? 0,
    );
  }

  return payload;
}

function buildErrorResponse(options, error) {
  const { internalErrorMessage, exposeErrorDetails } = options;
  const response = { error: internalErrorMessage };

  if (exposeErrorDetails || process.env.NODE_ENV === 'development') {
    response.details = error.message;
  }

  return response;
}

async function forwardToOpenAI(apiKey, payload) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  return { response, data };
}

function normalizeOpenAIResponse(data, requestPayload) {
  const choice = Array.isArray(data?.choices) ? data.choices[0] : null;
  const message = choice?.message;

  if (message && typeof message.content === 'string') {
    return {
      response: message.content,
      model: requestPayload.model,
      usage: data.usage,
      timestamp: new Date().toISOString(),
    };
  }

  if (message && Array.isArray(message.content)) {
    const combined = message.content
      .map(part => (typeof part?.text === 'string' ? part.text : ''))
      .filter(Boolean)
      .join('\n');

    if (combined) {
      return {
        response: combined,
        model: requestPayload.model,
        usage: data.usage,
        timestamp: new Date().toISOString(),
      };
    }
  }

  return null;
}

function handleOpenAiError(res, data, requestPayload) {
  console.error('OpenAI API Error:', data);

  if (data?.error) {
    const errorMessage = data.error.message || 'OpenAI APIエラー';
    const errorCode = data.error.code || 'unknown';

    if (errorCode === 'insufficient_quota') {
      return res.status(400).json({
        error: 'APIの使用量上限に達しました。管理者に連絡してください。',
      });
    }
    if (errorCode === 'invalid_api_key') {
      return res.status(401).json({
        error: 'APIキーが無効です。管理者に確認してください。',
      });
    }
    if (errorCode === 'model_not_found') {
      return res.status(400).json({
        error: `指定されたモデル（${requestPayload.model}）が見つかりません。`,
      });
    }

    return res.status(500).json({ error: `APIエラー: ${errorMessage}` });
  }

  return res
    .status(500)
    .json({ error: 'OpenAI APIから予期しないエラーが返されました' });
}

export function createOpenAIProxyHandler(options = {}) {
  const handlerOptions = {
    defaultModel: 'gpt-3.5-turbo',
    defaultTemperature: 0.7,
    defaultPresencePenalty: undefined,
    defaultFrequencyPenalty: undefined,
    defaultMaxTokens: 300,
    defaultMaxCompletionTokens: 300,
    internalErrorMessage: 'サーバー内部エラーが発生しました',
    exposeErrorDetails: true,
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
      return res
        .status(400)
        .json({ error: error.message || 'リクエスト形式が正しくありません' });
    }

    const body = normalized.body;
    const apiKey = resolveApiKey(req.headers, body);

    if (!apiKey) {
      return res.status(400).json({ error: 'OpenAI APIキーが指定されていません' });
    }

    const requestPayload = buildRequestPayload(
      body,
      normalized.messages,
      handlerOptions,
    );

    try {
      console.log('Making request to OpenAI with model:', requestPayload.model);

      const { response, data } = await forwardToOpenAI(apiKey, requestPayload);

      console.log('OpenAI response status:', response.status);

      if (!response.ok) {
        return handleOpenAiError(res, data, requestPayload);
      }

      const normalizedResponse = normalizeOpenAIResponse(data, requestPayload);
      if (normalizedResponse) {
        return res.json(normalizedResponse);
      }

      console.error('Unexpected response structure:', data);
      return res.status(500).json({
        error: 'AIからの応答が空または不正な形式です',
      });
    } catch (error) {
      console.error('API Handler Error:', error);

      if (error.name === 'TypeError' && error.message.includes('fetch')) {
        return res.status(503).json({
          error:
            'OpenAI APIへの接続に失敗しました。しばらく待ってから再試行してください。',
        });
      }

      return res
        .status(500)
        .json(buildErrorResponse(handlerOptions, error));
    }
  };
}
