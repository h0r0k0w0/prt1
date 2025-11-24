# プロジェクト概要

このリポジトリは、メンタライズ学習支援用のチャット UI と、OpenAI / Claude API へのプロキシエンドポイントを提供します。

## エンドポイント構成

- `/api/openai-proxy`
  - フロントエンドが標準的に利用するエンドポイントです。
  - アシスタントの応答品質を安定させるために presence/frequency penalty の既定値を付与します。
  - 本番利用を想定し、サーバー内部の詳細なエラー文言はユーザーに返さない設計です。
- `/api/claude-proxy`
  - Anthropic Claude モデルをサーバー経由で呼び出すための新しいエンドポイントです。
  - OpenAI ルートと同じ正規化ロジックを使いつつ、`https://api.anthropic.com/v1/messages` へ転送するよう調整しています。
  - レートリミットや認証エラーなど、Anthropic 固有のエラーコードを日本語メッセージに変換します。
- `/api/chat`
  - 過去のフロントエンド実装との後方互換性を保つために残しているレガシーエンドポイントです。
  - 実装そのものは `/api/openai-proxy` と共通化されており、追加のオプションを与えないラッパーに留めています。
  - 旧クライアントでも挙動の違いが生じないよう、詳細なエラー文言を返す設定にしています。

OpenAI 用ルートは `_openaiProxyHandler.js`、Claude 用ルートは `_anthropicProxyHandler.js` を介して、
`_messageUtils.js` でメッセージ履歴を正規化してから各プロバイダーの API へ転送します。

### 「サーバー側」の意味と Claude 連携

- `api/` フォルダの各ファイルは、Next.js や Vercel Edge Functions のような「サーバー側で動作する API ルート」に相当します。
  ブラウザから直接 OpenAI に鍵を付けてアクセスさせるのではなく、一度これらのエンドポイントに POST してから、サーバーが OpenAI へ代理で通信します。
- 現在は OpenAI / Claude の双方をサーバー経由で利用できます。`api/openai-proxy.js` は OpenAI 専用、`api/claude-proxy.js` は Claude 専用のラッパーです。
- どちらも内部で `_messageUtils.js` による正規化を行った後、`_openaiProxyHandler.js` / `_anthropicProxyHandler.js` が API 固有のヘッダーやレスポンス整形を担当します。
- Supabase を利用している場合でも、API ルートの配置は変わりません。Supabase には保存された設定（API キーやモデル名など）を保管し、フロントエンドから取得してリクエストに含めます。サーバー側で目的のプロバイダーへ転送する部分だけを差し替えれば、OpenAI と同様のフローで安全に Claude を呼び出せます。

> 参考: フロントエンドから直接 Claude API を呼び出す構成にしている場合は、新しいサーバーエンドポイントを作らなくても利用可能です。ただしブラウザに API キーが露出するため、保護が必要な環境ではサーバー経由のプロキシを推奨します。

## 会話履歴の正規化が必要な理由

過去の実装では、
- ローディング状態のプレースホルダーや、送信者情報の欠落したチャットログがそのまま API へ送られる
- system / user / assistant の区別が曖昧なまま 1 配列にまとめられる
といった問題があり、プロンプトに想定外のノイズが混入していました。

現在の実装では次の手順で履歴を整形しています。

1. 受け取った messages / chatHistory / history の各候補配列を走査し、ロール情報を明示的に付与
2. system メッセージが存在しない場合はシナリオに基づく既定の system プロンプトを補完
3. user ロールの発話が 1 件も無い場合はエラーを返し、プロンプトの破綻を防止

これにより、AI が過去のやり取りを正しく参照でき、ユーザーとアシスタントの発言が混ざらないようになっています。

## ファイル構成

```
api/
  |_ _anthropicProxyHandler.js # Claude (Anthropic) 向けリクエスト組み立て＆レスポンス処理
  |_ _messageUtils.js       # リクエスト正規化・APIキー抽出などの共通ユーティリティ
  |_ _openaiProxyHandler.js # OpenAI へのリクエスト組み立て＆レスポンス処理を担う共通ハンドラ
  |_ claude-proxy.js        # Claude 用 `/api/claude-proxy` エンドポイント定義
  |_ chat.js                # レガシー `/api/chat` 向け薄いラッパー
  |_ openai-proxy.js        # メインの `/api/openai-proxy` エンドポイント定義
index.html                  # フロントエンド
```

## よくある質問

### なぜ `_messageUtils.js` と `_openaiProxyHandler.js` を分けているのですか？

1 ファイルにすべてを詰め込むと責務が曖昧になり、挙動の差異が把握しづらくなります。メッセージ正規化処理と
OpenAI API 呼び出し処理を分離することで、

- テストやログの追加がしやすい
- 片方のみを差し替えるといった拡張が簡単
- どの段階で値が変換されるのかを追跡しやすい

というメリットがあります。

### 以前の実装と何が変わりましたか？

- リクエストボディに含まれる履歴配列・単発メッセージをすべて統合し、ロール付きで OpenAI に渡すようになりました。
- API キーをヘッダー／ボディのどちらに入れても動作し、Bearer トークン形式にも対応しています。
- OpenAI からのエラーを種類ごとに日本語で返しつつ、必要に応じて内部情報を隠蔽できるようになりました。

これらの変更は、チャットの応答品質を安定させ、エラーハンドリングを分かりやすくすることを目的としています。

## Supabase の RLS 設定例

フロントエンドは Supabase の `anon` キーで直接テーブルを操作するため、RLS を有効化するときは **`auth.role() = 'anon'` を許可するポリシー** がないと読み書きがすべて拒否されます。以下は、同意書管理を含む本 UI が利用するテーブル一式に対する最小限のポリシー例です。必要に応じて `service_role` など別ロールを追加してください。

### `to public using (true)` ではだめ？

Supabase の「Target roles」を空欄（= public）にし、`using (true)` のような無条件許可にすると、**RLS を有効にした意味がほぼなくなり、誰でも書き込み・削除できる状態** になります。既に他のテーブルでこの設定にしている場合でも、以下の理由でおすすめしません。

- public（= すべてのロール）向けのポリシーは、`service_role` や `authenticated` などより強い権限のクライアントにも同じ許可を与えてしまう
- 後から別ロールのポリシーを追加したときに、どの権限が最終的に効くか把握しづらい
- `anon` 以外の接続でも操作できてしまうため、意図しないバッチ処理やメンテナンスツールからデータが変更されるリスクがある

本プロジェクトのフロントエンドは `anon` ロールで接続する前提なので、**Target roles を `anon` に限定し、`auth.role() = 'anon'` を明示する** 方が安全です。既存の public ポリシーを残したい場合でも、少なくとも `insert`/`delete` はロールを絞ることを推奨します。

同意書提出テーブルだけ許可したいケースは、下記のように `consent_submissions` に限定した anon ロールのポリシーを作成すれば足ります。

```sql
alter table consent_submissions enable row level security;
create policy "anon can read consent_submissions"
  on consent_submissions for select using (auth.role() = 'anon');
create policy "anon can insert consent_submissions"
  on consent_submissions for insert with check (auth.role() = 'anon');
```

> それでも public ロールを使いたい場合は、対象ロールを `public` のままにしつつ `using (auth.role() = 'anon')` のように条件式で絞り込んでください。`using (true)` のような無条件許可は避けましょう。

```sql
-- admin_settings: 設定の取得と upsert を許可
alter table admin_settings enable row level security;
create policy "anon can read admin_settings"
  on admin_settings for select using (auth.role() = 'anon');
create policy "anon can upsert admin_settings"
  on admin_settings for insert with check (auth.role() = 'anon');
create policy "anon can update admin_settings"
  on admin_settings for update using (auth.role() = 'anon')
  with check (auth.role() = 'anon');

-- participants: 参加者の最終アクセス更新や削除に利用
alter table participants enable row level security;
create policy "anon can read participants"
  on participants for select using (auth.role() = 'anon');
create policy "anon can upsert participants"
  on participants for insert with check (auth.role() = 'anon');
create policy "anon can update participants"
  on participants for update using (auth.role() = 'anon') with check (auth.role() = 'anon');
create policy "anon can delete participants"
  on participants for delete using (auth.role() = 'anon');

-- participant_assignments: 7日分の割り当てを作成・参照
alter table participant_assignments enable row level security;
create policy "anon can read participant_assignments"
  on participant_assignments for select using (auth.role() = 'anon');
create policy "anon can insert participant_assignments"
  on participant_assignments for insert with check (auth.role() = 'anon');

-- experiment_logs: 実験記録の保存・閲覧・削除
alter table experiment_logs enable row level security;
create policy "anon can read experiment_logs"
  on experiment_logs for select using (auth.role() = 'anon');
create policy "anon can insert experiment_logs"
  on experiment_logs for insert with check (auth.role() = 'anon');
create policy "anon can delete experiment_logs"
  on experiment_logs for delete using (auth.role() = 'anon');

-- survey_results: アンケート結果の保存・参照・削除
alter table survey_results enable row level security;
create policy "anon can read survey_results"
  on survey_results for select using (auth.role() = 'anon');
create policy "anon can insert survey_results"
  on survey_results for insert with check (auth.role() = 'anon');
create policy "anon can delete survey_results"
  on survey_results for delete using (auth.role() = 'anon');

-- user_sessions: セッション開始/更新/削除で利用
alter table user_sessions enable row level security;
create policy "anon can read user_sessions"
  on user_sessions for select using (auth.role() = 'anon');
create policy "anon can insert user_sessions"
  on user_sessions for insert with check (auth.role() = 'anon');
create policy "anon can update user_sessions"
  on user_sessions for update using (auth.role() = 'anon') with check (auth.role() = 'anon');
create policy "anon can delete user_sessions"
  on user_sessions for delete using (auth.role() = 'anon');

-- consent_submissions: 同意書の提出記録を保存・表示
alter table consent_submissions enable row level security;
create policy "anon can read consent_submissions"
  on consent_submissions for select using (auth.role() = 'anon');
create policy "anon can insert consent_submissions"
  on consent_submissions for insert with check (auth.role() = 'anon');
```

> 上記は「Anon ロールを信頼する」ことを前提にしています。Supabase Auth ユーザーごとにデータを分離したい場合は `auth.uid()` や `jwt()` のクレームを使った条件式に置き換えてください。その場合、フロントエンドの supabase クライアントを匿名キーではなく認証済みのセッションで初期化する必要があります。

### サポートメッセージ用の RLS 例

参加者の送信ボタンで `new row violates row-level security policy for table "support_messages"` が出る場合は、以下のように `anon` ロールを許可するポリシーを追加してください（管理者は `authenticated` または `service_role` 前提）。Supabase Auth のサインインを使わず匿名キーだけで接続する場合は `current_setting('request.jwt.claims.sub', true)` が `NULL` になるため、そのケースも許可しています。

> ⚠️ 管理画面も `anon` キーでアクセスする場合は、下記の「Option B: 匿名キーのみで管理者送信を許可」を併用してください。そうしないと管理者送信が 401/RLS で拒否されます。安全のため本番では Option A を推奨します。

```sql
alter table support_messages enable row level security;

-- 参加者が自分のスレッドを参照/投稿
create policy "anon can read support_messages"
  on support_messages
  for select
  using (
    auth.role() = 'anon'
    and (
      current_setting('request.jwt.claims.sub', true) is null
      or user_id = current_setting('request.jwt.claims.sub', true)
    )
  );

create policy "anon can insert support_messages"
  on support_messages
  for insert
  with check (
    auth.role() = 'anon'
    and sender_type = 'user'
    and (
      current_setting('request.jwt.claims.sub', true) is null
      or user_id = current_setting('request.jwt.claims.sub', true)
    )
  );

-- 管理者が全件参照・返信（dashboard / service_role 想定）
create policy "admins manage support_messages"
  on support_messages
  for all
  using (auth.role() in ('authenticated', 'service_role'))
  with check (auth.role() in ('authenticated', 'service_role'));
```

> Supabase Auth で参加者ごとに JWT を発行している場合は `current_setting('request.jwt.claims.sub', true)` 部分を適切なクレーム名に合わせてください。逆に匿名キーだけで利用する場合は、上記のように `sub` が `NULL` でも通る条件を残しておかないと RLS で拒否されます。

#### Option A: 管理者は service_role / authenticated で送信する（推奨）

管理画面から送信する場合は、Supabase Auth でサインインしたトークンか service_role キーを用いてリクエストしてください。RLS 上は上記の `admins manage support_messages` ポリシーのみで通るため、匿名キーではなく管理者用のセッション/キーを使うのが安全です。

#### Option B: 匿名キーしか使わない場合の一時的なポリシー例

研究室内の限定利用などで「管理者 UI も anon キーのみ」で済ませたい場合は、管理者送信専用の anon ポリシーを追加します。参加者が `sender_type = 'admin'` で POST しても通ってしまうため、本番運用には向きません。

```sql
-- 匿名キーで sender_type = 'admin' を許可（限定利用向け）
create policy "anon can insert admin support_messages"
  on support_messages
  for insert
  with check (
    auth.role() = 'anon'
    and sender_type = 'admin'
  );
```
