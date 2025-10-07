import {
  prepareConversationPayload,
  resolveApiKey,
  toNumber,
} from './_messageUtils.js';

export default async function handler(req, res) {
  // CORS設定
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

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
    return res.status(400).json({ error: error.message || 'リクエスト形式が正しくありません' });
  }

  const body = normalized.body;
  const apiKey = resolveApiKey(req.headers, body);

  if (!apiKey) {
    return res.status(400).json({ error: 'OpenAI APIキーが指定されていません' });
  }

  const model = typeof body.model === 'string' && body.model.trim()
    ? body.model.trim()
    : 'gpt-3.5-turbo';

  const maxTokens = body.max_completion_tokens != null
    ? undefined
    : toNumber(body.maxTokens ?? body.max_tokens, 300);

  const requestPayload = {
    model,
    messages: normalized.messages,
    temperature: toNumber(body.temperature, 0.7),
  };

  if (body.max_completion_tokens != null) {
    requestPayload.max_completion_tokens = toNumber(body.max_completion_tokens, 300);
  } else if (maxTokens != null) {
    requestPayload.max_tokens = maxTokens;
  }

  if (body.presence_penalty != null) {
    requestPayload.presence_penalty = toNumber(body.presence_penalty, 0);
  }
  if (body.frequency_penalty != null) {
    requestPayload.frequency_penalty = toNumber(body.frequency_penalty, 0);
  }

  try {
    console.log('Making request to OpenAI with model:', requestPayload.model);

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(requestPayload),
    });

    const data = await response.json();
    console.log('OpenAI response status:', response.status);

    if (!response.ok) {
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

      return res.status(500).json({ error: 'OpenAI APIから予期しないエラーが返されました' });
    }

    const choice = Array.isArray(data?.choices) ? data.choices[0] : null;
    const message = choice?.message;

    if (message && typeof message.content === 'string') {
      return res.json({
        response: message.content,
        model: requestPayload.model,
        usage: data.usage,
        timestamp: new Date().toISOString(),
      });
    }

    if (message && Array.isArray(message.content)) {
      const combined = message.content
        .map(part => (typeof part?.text === 'string' ? part.text : ''))
        .filter(Boolean)
        .join('\n');

      if (combined) {
        return res.json({
          response: combined,
          model: requestPayload.model,
          usage: data.usage,
          timestamp: new Date().toISOString(),
        });
      }
    }

    console.error('Unexpected response structure:', data);
    return res.status(500).json({
      error: 'AIからの応答が空または不正な形式です',
    });
  } catch (error) {
    console.error('API Handler Error:', error);
    console.error('Error stack:', error.stack);

    return res.status(500).json({
      error: 'サーバー内部エラーが発生しました',
      details: error.message,
    });
  }
}
