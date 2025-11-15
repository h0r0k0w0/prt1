import {
  prepareConversationPayload,
  resolveApiKey,
  toNumber,
} from './_messageUtils.js';

const DEFAULT_RESPONSE_FORMAT = {
  type: 'json_schema',
  json_schema: {
    name: 'reply_and_state',
    schema: {
      type: 'object',
      properties: {
        reply: {
          type: 'string',
          description:
            'ユーザーに表示する受容文と質問文を統合したメッセージを文字列で返してください。',
        },
        state: {
          description:
            '現在の分析結果を表すState全体をJSONオブジェクトで返してください。該当する情報がなければnullを返してください。',
          oneOf: [
            { type: 'object', additionalProperties: true },
            { type: 'null' },
          ],
        },
      },
      required: ['reply', 'state'],
      additionalProperties: false,
    },
  },
};

/**
 * OpenAI へのリクエスト送信処理を共通化したハンドラ。
 *
 * - リクエストボディを正規化して system/user/assistant ロール付きの messages 配列を生成
 * - ルートごとの既定値（モデル、温度、ペナルティなど）を柔軟に差し替え可能
 * - OpenAI API からのエラーを種類別にハンドリングし、日本語のメッセージを返却
 *
 * `chat.js` / `openai-proxy.js` から呼び出すことで、両エンドポイントの挙動差を
 * オプションによる宣言的な記述に閉じ込めています。
 */

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

function buildRequestPayload(body, normalized, options) {
  const normalizedMessages = normalized.messages;
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

  const explicitResponseFormat = body.response_format ?? body.responseFormat;
  if (explicitResponseFormat) {
    payload.response_format = explicitResponseFormat;
  } else if (normalized.expectsStructuredResponse) {
    payload.response_format = DEFAULT_RESPONSE_FORMAT;
  }

  if (Array.isArray(body.tools)) {
    payload.tools = body.tools;
  }

  const toolChoice = body.tool_choice ?? body.toolChoice;
  if (toolChoice != null) {
    payload.tool_choice = toolChoice;
  }

  const parallelToolCalls = body.parallel_tool_calls ?? body.parallelToolCalls;
  if (parallelToolCalls != null) {
    payload.parallel_tool_calls = parallelToolCalls;
  }

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

  if (!message) {
    return null;
  }

  const rawText = extractMessageText(message);
  const structured = parseStructuredContent(rawText);

  return {
    response: structured.reply ?? rawText ?? '',
    reply: structured.reply ?? rawText ?? '',
    state: structured.state,
    rawResponse: rawText ?? '',
    model: requestPayload.model,
    usage: data.usage,
    timestamp: new Date().toISOString(),
  };
}

function extractMessageText(message) {
  if (typeof message?.content === 'string') {
    return message.content;
  }

  if (Array.isArray(message?.content)) {
    return message.content
      .map(part => {
        if (typeof part?.text === 'string') return part.text;
        if (Array.isArray(part?.content)) {
          return part.content
            .map(inner => (typeof inner?.text === 'string' ? inner.text : ''))
            .filter(Boolean)
            .join('\n');
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  return '';
}

function parseStructuredContent(rawText) {
  if (typeof rawText !== 'string' || !rawText.trim()) {
    return { reply: null, state: null };
  }

  const cleaned = stripCodeFences(rawText.trim());

  const parsed = tryParseJson(cleaned) ?? tryParseEmbeddedJson(cleaned);

  if (!parsed || typeof parsed !== 'object') {
    return { reply: null, state: null };
  }

  const reply = typeof parsed.reply === 'string' ? parsed.reply : null;
  const state = normalizeState(parsed.state);

  return { reply, state };
}

function stripCodeFences(text) {
  const fenceMatch = text.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)```$/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }
  return text;
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

function tryParseEmbeddedJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  const snippet = text.slice(start, end + 1);
  return tryParseJson(snippet);
}

function normalizeState(stateValue) {
  if (stateValue == null) {
    return null;
  }

  if (typeof stateValue === 'object') {
    return stateValue;
  }

  if (typeof stateValue === 'string' && stateValue.trim()) {
    try {
      return JSON.parse(stateValue);
    } catch (error) {
      return stateValue;
    }
  }

  return stateValue;
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

    const requestPayload = buildRequestPayload(body, normalized, handlerOptions);

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
