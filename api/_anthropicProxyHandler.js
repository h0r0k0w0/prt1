import {
  prepareConversationPayload,
  resolveApiKey,
  toNumber,
} from './_messageUtils.js';

const DEFAULT_STATE_TOOL = {
  name: 'state_update',
  description:
    'ユーザーへの返信文(reply)と更新後のstate(JSON)を含む構造化出力を返すためのツールです。',
  input_schema: {
    type: 'object',
    properties: {
      reply: {
        type: 'string',
        description: 'ユーザーに送る受容文と質問文を統合したメッセージ。',
      },
      state: {
        description: '更新後のState全体。',
        oneOf: [
          { type: 'object', additionalProperties: true },
          { type: 'null' },
        ],
      },
    },
    required: ['reply', 'state'],
    additionalProperties: false,
  },
};

function createDefaultStateTool() {
  return JSON.parse(JSON.stringify(DEFAULT_STATE_TOOL));
}

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

function toAnthropicContentBlock(text) {
  return [{ type: 'text', text }];
}

// Systemメッセージ群とユーザー/assistantターンを分離し、stateを含むsystemメッセージにフラグを付与する。
// stateMessageContent は prepareConversationPayload が生成する「Stateを埋め込んだsystemテキスト」そのもの。
function normalizeConversation(messages, stateMessageContent) {
  const systemMessages = [];
  const conversation = [];

  for (const message of messages) {
    if (!message || typeof message.content !== 'string') continue;

    const trimmed = message.content.trim();
    if (!trimmed) continue;

    if (message.role === 'system') {
      systemMessages.push({
        text: trimmed,
        // stateを埋め込んだsystemメッセージと完全一致する場合だけ動的ブロックとしてマークする。
        isState: !!stateMessageContent && trimmed === stateMessageContent,
      });
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
    systemBlocks: systemMessages,
    conversation,
  };
}

// Claudeは "system" メッセージに対してのみ cache_control を最大4ブロックまで付けられるため、
// それ以外（user/assistant）のターンはここでは扱わない。超過分は後ろ側をマージする。
// isStateフラグはマージ後のブロックにもORで引き継ぎ、"この塊は動的stateを含む"という判定を維持する。
function limitCacheBreakpoints(blocks, maxBreakpoints = 4) {
  const limited = blocks.map(block => ({ ...block }));

  while (limited.length > maxBreakpoints) {
    const overflow = limited.splice(maxBreakpoints - 1);
    const mergedText = overflow.map(part => part.text).filter(Boolean).join('\n\n');
    limited[maxBreakpoints - 1].text = [
      limited[maxBreakpoints - 1].text,
      mergedText,
    ]
      .filter(Boolean)
      .join('\n\n');
    limited[maxBreakpoints - 1].isState =
      limited[maxBreakpoints - 1].isState || overflow.some(part => part.isState);
  }

  return limited;
}

function buildSystemField(systemBlocks, cacheType) {
  if (!systemBlocks.length) return null;

  if (cacheType) {
    const limitedBlocks = limitCacheBreakpoints(systemBlocks);
    return limitedBlocks.map(block => ({
      type: 'text',
      text: block.text,
      cache_control: { type: cacheType },
    }));
  }

  return systemBlocks.map(block => block.text).filter(Boolean).join('\n\n');
}

function buildRequestPayload(body, normalized, options) {
  const normalizedMessages = normalized.messages;
  const {
    defaultModel,
    defaultTemperature,
    defaultMaxTokens,
    defaultTopP,
    defaultTopK,
  } = options;

  const { systemBlocks, conversation } = normalizeConversation(
    normalizedMessages,
    normalized.stateMessageContent,
  );

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

  const topK = toNumber(body.top_k ?? body.topK, defaultTopK);
  if (topK != null) {
    payload.top_k = topK;
  }

  const stopSequences = body.stop_sequences ?? body.stopSequences;
  if (Array.isArray(stopSequences) && stopSequences.length) {
    payload.stop_sequences = stopSequences
      .map(value => (typeof value === 'string' ? value : ''))
      .filter(Boolean);
  }

  const thinkingModeRaw = body.thinking_mode ?? body.thinkingMode;
  const thinkingMode = typeof thinkingModeRaw === 'string'
    ? thinkingModeRaw.trim()
    : null;
  const thinkingBudget = toNumber(
    body.thinking_budget_tokens ?? body.thinkingBudgetTokens,
    null,
  );
  if (thinkingMode === 'enabled') {
    payload.thinking = { type: 'enabled' };
    if (thinkingBudget != null) {
      payload.thinking.budget_tokens = thinkingBudget;
    }
  } else if (thinkingMode === 'disabled') {
    payload.thinking = { type: 'disabled' };
  } else if (thinkingBudget != null) {
    payload.thinking = { type: 'enabled', budget_tokens: thinkingBudget };
  }

  const cacheControl = body.system_cache_control ?? body.systemCacheControl;
  const cacheType = typeof cacheControl?.type === 'string'
    ? cacheControl.type.trim()
    : null;

  if (systemBlocks.length) {
    const systemField = buildSystemField(systemBlocks, cacheType);
    if (systemField) {
      payload.system = systemField;
    }
  }

  const explicitTools = Array.isArray(body.tools) ? body.tools : null;
  if (explicitTools && explicitTools.length) {
    payload.tools = explicitTools;
  } else if (normalized.expectsStructuredResponse) {
    payload.tools = [createDefaultStateTool()];
  }

  const toolChoice = body.tool_choice ?? body.toolChoice;
  if (toolChoice != null) {
    payload.tool_choice = toolChoice;
  } else if (payload.tools && payload.tools.length === 1 && normalized.expectsStructuredResponse) {
    payload.tool_choice = { type: 'tool', name: payload.tools[0].name };
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

  let textResponse = '';
  let structuredReply = null;
  let structuredState = null;

  for (const part of content) {
    if (!part) continue;

    if (part.type === 'tool_use' && part.input && structuredReply == null) {
      const input = part.input;
      if (typeof input.reply === 'string') {
        structuredReply = input.reply;
      }
      if (input.state !== undefined) {
        structuredState = normalizeState(input.state);
      }
      continue;
    }

    if (typeof part.text === 'string' && part.text.trim()) {
      textResponse += (textResponse ? '\n' : '') + part.text.trim();
    } else if (Array.isArray(part.content)) {
      const nestedText = part.content
        .map(inner => (typeof inner?.text === 'string' ? inner.text : ''))
        .filter(Boolean)
        .join('\n')
        .trim();
      if (nestedText) {
        textResponse += (textResponse ? '\n' : '') + nestedText;
      }
    }
  }

  if (structuredReply == null && textResponse) {
    const parsed = parseStructuredText(textResponse);
    if (parsed) {
      structuredReply = parsed.reply ?? structuredReply;
      if (structuredState == null) {
        structuredState = parsed.state;
      }
    }
  }

  const reply = structuredReply ?? (textResponse || null);

  if (reply == null && structuredState == null) {
    return null;
  }

  return {
    response: reply ?? '',
    reply: reply ?? '',
    state: structuredState,
    rawResponse: textResponse,
    model: data.model ?? requestPayload.model,
    usage: data.usage,
    timestamp: new Date().toISOString(),
  };
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

function parseStructuredText(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return null;
  }

  const cleaned = stripCodeFences(text.trim());
  const parsed = tryParseJson(cleaned) ?? tryParseEmbeddedJson(cleaned);

  if (!parsed || typeof parsed !== 'object') {
    return null;
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
    defaultTopK: undefined,
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
      requestPayload = buildRequestPayload(body, normalized, handlerOptions);
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
