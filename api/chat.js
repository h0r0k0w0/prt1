export default async function handler(req, res) {
  // CORS設定
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    console.log('Request body:', req.body);
    
    const { 
      message, 
      scenario, 
      apiKey, 
      model = 'gpt-3.5-turbo',
      maxTokens = 300,
      temperature = 0.7,
      systemPrompt
    } = req.body;

    // 入力検証
    if (!message || !scenario || !apiKey) {
      console.log('Missing required fields:', { message: !!message, scenario: !!scenario, apiKey: !!apiKey });
      return res.status(400).json({ 
        error: 'メッセージ、シナリオ、APIキーは必須です' 
      });
    }

    // システムプロンプトの構築
    const finalSystemPrompt = systemPrompt || `あなたは心理学の専門家として、メンタライズ（他者の心の理解）を教えるエージェントです。

シナリオ: ${scenario}

以下のガイドラインに従って応答してください：
1. 学生の考えを肯定的に受け止める
2. より深い分析を促す質問をする
3. 登場人物の感情や動機についてヒントを提供する
4. 具体的な観察ポイントを示す
5. 温かく支援的な口調で話す

応答は200文字以内で、次の質問や気づきを促すようにしてください。`;

    console.log('Making request to OpenAI with model:', model);

    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: model,
        messages: [
          { role: 'system', content: finalSystemPrompt },
          { role: 'user', content: message }
        ],
        max_tokens: parseInt(maxTokens),
        temperature: parseFloat(temperature)
      })
    });

    console.log('OpenAI response status:', response.status);

    const data = await response.json();
    console.log('OpenAI response data:', data);
    
    if (!response.ok) {
      console.error('OpenAI API Error:', data);
      
      if (data.error) {
        const errorMessage = data.error.message || 'OpenAI APIエラー';
        const errorCode = data.error.code || 'unknown';
        
        if (errorCode === 'insufficient_quota') {
          return res.status(400).json({ 
            error: 'APIの使用量上限に達しました。管理者に連絡してください。' 
          });
        } else if (errorCode === 'invalid_api_key') {
          return res.status(401).json({ 
            error: 'APIキーが無効です。管理者に確認してください。' 
          });
        } else if (errorCode === 'model_not_found') {
          return res.status(400).json({ 
            error: `指定されたモデル（${model}）が見つかりません。` 
          });
        } else {
          return res.status(500).json({ 
            error: `APIエラー: ${errorMessage}` 
          });
        }
      }
      
      return res.status(500).json({ error: 'OpenAI APIから予期しないエラーが返されました' });
    }
    
    if (data.choices && data.choices.length > 0 && data.choices[0].message) {
      const aiResponse = data.choices[0].message.content;
      console.log('AI response generated successfully');
      
      return res.json({ 
        response: aiResponse,
        model: model,
        usage: data.usage,
        timestamp: new Date().toISOString()
      });
    } else {
      console.error('Unexpected response structure:', data);
      return res.status(500).json({ 
        error: 'AIからの応答が空または不正な形式です' 
      });
    }
    
  } catch (error) {
    console.error('API Handler Error:', error);
    console.error('Error stack:', error.stack);
    
    return res.status(500).json({ 
      error: 'サーバー内部エラーが発生しました',
      details: error.message
    });
  }
}
