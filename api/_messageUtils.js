const DEFAULT_GUIDELINE = `以下のガイドラインに従って応答してください：
1. 学生の考えを肯定的に受け止める
2. より深い分析を促す質問をする
3. 登場人物の感情や動機についてヒントを提供する
4. 具体的な観察ポイントを示す
5. 温かく支援的な口調で話す

応答は200文字以内で、次の質問や気づきを促すようにしてください。`;

function extractBearerToken(headerValue = '') {
  if (typeof headerValue !== 'string') return '';
  const trimmed = headerValue.trim();
  if (!trimmed.toLowerCase().startsWith('bearer ')) return '';
  return trimmed.slice(7).trim();
}

function normalizeRole(rawRole, sender) {
  const role = typeof rawRole === 'string' ? rawRole.toLowerCase() : '';
  if (role === 'system' || role === 'user' || role === 'assistant' || role === 'tool') {
    return role;
  }

  if (role === 'model') {
    return 'assistant';
  }
  if (role === 'ai') {
    return 'assistant';
  }
  if (role === 'human') {
    return 'user';
  }

  const senderRole = typeof sender === 'string' ? sender.toLowerCase() : '';
  if (senderRole === 'assistant' || senderRole === 'ai') {
    return 'assistant';
  }
  if (senderRole === 'system') {
    return 'system';
  }

  return 'user';
}

function collectText(value) {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(collectText).filter(Boolean).join('\n');
  }

  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') {
      return value.text;
    }
    if (Array.isArray(value.parts)) {
      return value.parts.map(collectText).filter(Boolean).join('\n');
    }
    if (typeof value.content === 'string') {
      return value.content;
    }
    if (Array.isArray(value.content)) {
      return value.content.map(collectText).filter(Boolean).join('\n');
    }
  }

  if (value == null) {
    return '';
  }

  return String(value);
}

function sanitizeTurns(turns = []) {
  const sanitized = [];

  for (const turn of turns) {
    if (!turn) continue;

    const role = normalizeRole(turn.role, turn.sender);
    const content = collectText(turn.content ?? turn.message ?? turn.text ?? '');

    sanitized.push({ role, content });
  }

  return sanitized;
}

function buildDefaultSystemPrompt(scenarioText = '') {
  const scenario = scenarioText ? `\n\nシナリオ: ${scenarioText}` : '';
  return `あなたは心理学の専門家として、メンタライズ（他者の心の理解）を教えるエージェントです。${scenario}\n\n${DEFAULT_GUIDELINE}`;
}

export function parseRequestBody(body) {
  if (!body) return {};
  if (typeof body === 'object') return body;

  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error('リクエストボディがJSONとして解析できません');
  }
}

export function prepareConversationPayload(rawBody) {
  const body = parseRequestBody(rawBody);

  const scenario = typeof body.scenario === 'string' ? body.scenario.trim() : '';
  const providedSystemPrompt = typeof body.systemPrompt === 'string' ? body.systemPrompt.trim() : '';
  const defaultSystemPrompt = buildDefaultSystemPrompt(scenario);
  const finalSystemPrompt = providedSystemPrompt || defaultSystemPrompt;

  const turnCandidates = Array.isArray(body.messages)
    ? body.messages
    : Array.isArray(body.chatHistory)
    ? body.chatHistory
    : Array.isArray(body.history)
    ? body.history
    : [];

  let messages = sanitizeTurns(turnCandidates);

  const hasSystemInTurns = messages.some(msg => msg.role === 'system');
  if (!hasSystemInTurns && finalSystemPrompt) {
    messages = [{ role: 'system', content: finalSystemPrompt }, ...messages];
  }

  if (!messages.length) {
    if (finalSystemPrompt) {
      messages.push({ role: 'system', content: finalSystemPrompt });
    }
  }

  const messageText = typeof body.message === 'string' ? body.message : '';
  const hasUserTurn = messages.some(msg => msg.role === 'user');

  if (!hasUserTurn && messageText) {
    const prefix = scenario ? `シナリオ: ${scenario}\n\nユーザーの発言: ` : '';
    messages.push({ role: 'user', content: `${prefix}${messageText}` });
  }

  if (!messages.some(msg => msg.role === 'user')) {
    throw new Error('ユーザーの発話が含まれていません');
  }

  return {
    body,
    scenario,
    finalSystemPrompt,
    messages,
  };
}

export function resolveApiKey(reqHeaders = {}, body = {}) {
  const headerKey = extractBearerToken(reqHeaders.authorization || reqHeaders.Authorization);
  const bodyKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  return headerKey || bodyKey;
}

export function toNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

