export default async function handler(req, res) {
    // CORSヘッダーを設定
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { message, scenario, apiKey } = req.body;
    
    const prompt = `
あなたは心理学の専門家として、メンタライズ（他者の心の理解）を教えるエージェントです。

シナリオ: ${scenario}

学生の発言: ${message}

以下のガイドラインに従って応答してください：
1. 学生の考えを肯定的に受け止める
2. より深い分析を促す質問をする
3. 登場人物の感情や動機についてヒントを提供する
4. 具体的な観察ポイントを示す
5. 温かく支援的な口調で話す

応答は200文字以内で、次の質問や気づきを促すようにしてください。
    `;

    try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: 'gpt-3.5-turbo',
                messages: [
                    { role: 'system', content: prompt },
                    { role: 'user', content: message }
                ],
                max_tokens: 300,
                temperature: 0.7
            })
        });

        const data = await response.json();
        
        if (data.choices && data.choices[0]) {
            res.json({ response: data.choices[0].message.content });
        } else {
            res.status(500).json({ error: 'AI応答の生成に失敗しました' });
        }
    } catch (error) {
        console.error('API Error:', error);
        res.status(500).json({ error: 'サーバーエラーが発生しました' });
    }
}