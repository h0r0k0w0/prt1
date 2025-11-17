/**
 * メッセージ履歴の正規化や API キー抽出など、エンドポイント共通で必要になる
 * ユーティリティ群をここにまとめています。
 */

const DEFAULT_GUIDELINE = `以下のガイドラインに従って応答してください：
1. 学生の考えを肯定的に受け止める
2. より深い分析を促す質問をする
3. 登場人物の感情や動機についてヒントを提供する
4. 具体的な観察ポイントを示す
5. 温かく支援的な口調で話す

応答は200文字以内で、次の質問や気づきを促すようにしてください。`;

const STRUCTURED_OUTPUT_INSTRUCTION = `必ず次の形式で応答してください。

{
  "reply": "受容文と質問文を統合したユーザー向けメッセージ",
  "state": { ...更新後のState全体... }
}

replyには自然な文章を入れ、stateには現在の分析結果を表すJSON全体を入れてください。`;

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

function serializeStateForPrompt(stateValue) {
  if (stateValue == null) {
    return null;
  }

  if (typeof stateValue === 'string') {
    const trimmed = stateValue.trim();
    if (!trimmed) {
      return null;
    }

    try {
      const parsed = JSON.parse(trimmed);
      return JSON.stringify(parsed, null, 2);
    } catch (error) {
      return trimmed;
    }
  }

  if (typeof stateValue === 'object') {
    try {
      return JSON.stringify(stateValue, null, 2);
    } catch (error) {
      return null;
    }
  }

  return String(stateValue);
}

function tryParseStateObject(stateValue) {
  if (stateValue == null) {
    return null;
  }

  if (typeof stateValue === 'object') {
    try {
      return JSON.parse(JSON.stringify(stateValue));
    } catch (error) {
      return null;
    }
  }

  if (typeof stateValue === 'string' && stateValue.trim()) {
    try {
      return JSON.parse(stateValue);
    } catch (error) {
      return null;
    }
  }

  return null;
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

  const serializedState = serializeStateForPrompt(body.state);
  const parsedState = tryParseStateObject(body.state);

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

  const expectsStructuredResponse =
    body.expectStructuredResponse !== false && (serializedState != null || body.expectStructuredResponse === true);

  // (2) reply/state形式の構造化出力指示を system として差し込む
  if (expectsStructuredResponse) {
    const instructionMessage = { role: 'system', content: STRUCTURED_OUTPUT_INSTRUCTION };

    const existingInstructionIndex = messages.findIndex(
      message => message.role === 'system' && message.content === STRUCTURED_OUTPUT_INSTRUCTION,
    );

    if (existingInstructionIndex === -1) {
      const firstSystemIndex = messages.findIndex(message => message.role === 'system');
      if (firstSystemIndex >= 0) {
        messages.splice(firstSystemIndex + 1, 0, instructionMessage);
      } else {
        messages.unshift(instructionMessage);
      }
    }
  }

  let stateMessageContent = null;

  // (3) 現在のStateだけを埋め込んだ system メッセージ（動的部分）を最後の system 直後に差し込む
  //     ※ここには管理画面のプロンプト文面は再掲せず、State JSON の本文だけを入れる
  if (serializedState) {
    stateMessageContent = `現在のState JSONは次の通りです。モデルはこの内容を参照し、更新した結果をstateフィールドに返してください。\n${serializedState}`;

    const stateMessage = {
      role: 'system',
      content: stateMessageContent,
    };

    const lastSystemIndex = messages.reduce(
      (lastIndex, message, index) => (message.role === 'system' ? index : lastIndex),
      -1,
    );

    if (lastSystemIndex >= 0) {
      messages.splice(lastSystemIndex + 1, 0, stateMessage);
    } else {
      messages.unshift(stateMessage);
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
    serializedState,
    parsedState,
    stateMessageContent,
    expectsStructuredResponse,
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

