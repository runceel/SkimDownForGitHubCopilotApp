# SkimDown for GitHub Copilot App

macOS 向け Markdown リーダー [SkimDown](https://skimdown.07jp27.net/) を原作とする拡張です。
原作者の許可を得て
[SkimDown for Windows](https://github.com/runceel/SkimDownForWindows)（WinUI 3 + WebView2）へ移植し、
GitHub Copilot app の extension canvas として動作するようにしています。

用途は 2 つです。

1. **そのセッションで生成された Markdown を読む** — 成果物、エージェントが書いた `.md`、チャットから直接渡されたテキスト
2. **既存の Markdown を読む** — ワークスペース配下、または任意のファイルやフォルダー

![このセッションで生成された Markdown を表示している SkimDown canvas](docs/screenshot-dark.png)

## インストール

拡張はこのリポジトリの `.github/extensions/skimdown/` にあります。
このリポジトリをプロジェクトとして開くと自動で読み込まれます。

他のリポジトリでも使う場合は、GitHub Copilot app で次のように依頼して、
公開リポジトリのフォルダー URL からユーザースコープへインストールします。

> 次の GitHub リポジトリフォルダーから SkimDown をユーザースコープへインストールしてください。
>
> `https://github.com/runceel/SkimDownForGitHubCopilotApp/tree/main/.github/extensions/skimdown`

`main` の URL は常に最新版を指します。再現可能なインストールには、リリース後に `main` を
バージョンタグへ置き換えた URL を使います。

```text
https://github.com/runceel/SkimDownForGitHubCopilotApp/tree/v1.0.1/.github/extensions/skimdown
```

リリースページには、手動インストール用の ZIP と SHA-256 チェックサムも添付されます。
ZIP を展開すると、ユーザーの拡張ディレクトリへ配置できる `skimdown/` フォルダーになります。

拡張はローカルでコードを実行します。信頼できるタグまたはコミットを指定し、
インストール前に変更内容を確認してください。公開済みのタグは移動しません。
更新には新しいバージョンを使います。

## 使い方

エージェントへ次のように依頼します。

- 「SkimDown で `docs/architecture.md` を開いて」
- 「このセッションで作った Markdown を SkimDown で見せて」
- 「今の設計案を SkimDown で表示して」（ファイルを作らずに表示します）
- 「SkimDown をブラウザーで開いて」（既定ブラウザーで開き直します）

## Canvas アクション

| アクション | 入力 | 動作 |
| --- | --- | --- |
| `show_markdown` | `markdown`, `title?`, `id?` | ファイルを作らずに Markdown を表示します。`id` を渡すと同じドキュメントを上書き更新します |
| `open_path` | `path` | ファイルなら単体表示、フォルダーならツリーのルートにします |
| `open_session` | — | 「このセッション」ソースに切り替えます |
| `open_in_browser` | `path?` | 開いているパネルを OS の既定ブラウザーで表示します。`path` を渡すと、その文書を選んでから表示します。パネル URL は返しません |
| `refresh` | — | 現在のソースを再スキャンします |
| `list_files` | `source?` | ドキュメント一覧を返します。`source` を渡すと表示を変えずにそのソースを一覧します |
| `get_state` | — | 現在のソース、ルート、選択中のドキュメントを返します |

`open_canvas` の入力（`path` / `markdown` / `title` / `id` / `source`）で初期表示を指定できます。

## ソース

サイドバー上部のセレクターで 3 つのソースを切り替えます。

| ソース | 内容 |
| --- | --- |
| **このセッション** | セッション成果物（`plan.md` と `files/**`）、エージェントが編集した `.md`、`show_markdown` で渡されたドキュメント、チェックポイントを、グループ見出し付きの新しい順で表示します |
| **ワークスペース** | 開いているリポジトリ配下を SkimDown と同じツリーで表示します。`session.workspacePath` がセッション作業ディレクトリを指す場合は、最寄りの git リポジトリを探します |
| **パスを開く** | `open_path` や `open_canvas` の `input.path` で指定したファイルやフォルダーを表示します |

探索対象は `.md` と `.markdown` です。`.git`、`node_modules`、`.build`、`DerivedData`、
およびドットで始まる名前は、どの深さでも除外します。

## 操作

| 操作 | 割り当て |
| --- | --- |
| 文書内検索 | `Ctrl+F`、`Enter` / `Shift+Enter` で移動、`Ctrl+E` で選択文字列を検索 |
| サイドバー開閉 | `Ctrl+B` |
| プライバシーと履歴 | サイドバー下部の盾ボタンから、保存、保持期間、消去を管理 |
| ズーム | `Ctrl+;` / `Ctrl+-` / `Ctrl+0`、ツールバーの `+` / `−` / `100%` |
| 本文の最大幅 | `Ctrl+[` / `Ctrl+]` |
| パスを開く | `Ctrl+O` |
| 既定ブラウザーで表示 | ツールバーの外部表示ボタン、またはエージェントへの依頼 |
| 全選択 | `Ctrl+A` |

- Mermaid 図はクリックで拡大モーダルが開き、ホイールでズーム、ドラッグでパンできます。
- コードブロックにはコピーボタンが付きます。
- 開いているファイルは、ディスク上の変更を検知して自動で再読み込みします。
- ブラウザー表示は元の canvas と同じ状態と更新を共有し、canvas を閉じると接続も終了します。
- ブラウザー表示の起動先は OS の既定ブラウザーです。ブラウザーを指定する手段はなく、
  Edge で開きたい場合は Edge を既定ブラウザーにしてください。
- 外部リンクはすぐには開きません。URL を表示した確認バーで承認したものだけを、OS の既定ブラウザーへ渡します。

## リモートコンテンツとプライバシー

Markdown 内の HTTP(S) 画像とメディアは、既定では読み込みません。文書にリモート参照があると
確認バーが表示され、「この文書で読み込む」を選んだ場合だけ読み込みます。許可は表示中の文書の
現在の内容にだけ適用され、内容が変わると再確認が必要です。全体を常時許可する設定はありません。

許可した場合も、ブラウザーから参照先へ直接接続せず、SkimDown の loopback サーバーを経由します。
リクエストは `Referrer-Policy: no-referrer` で処理し、リダイレクト先を含めて DNS 解決結果を
検査します。次の宛先は許可後も読み込みません。

- loopback、link-local、プライベート / unique-local IP
- 単一ラベルの intranet ホスト名と `.local` / `.internal` / `.home` / `.lan`
- 画像・音声・動画以外の応答、20 MB を超える応答

## 状態の保存先

リポジトリには何も書きません。セッション履歴は既定では端末へ保存せず、
開いている拡張プロセスのメモリ内だけで保持します。

| スコープ | 場所 |
| --- | --- |
| ユーザー全体の設定 | `$COPILOT_HOME/extensions/skimdown/artifacts/settings.json` |
| セッションごとの履歴（保存を有効にした場合のみ） | `$COPILOT_HOME/extensions/skimdown/artifacts/sessions/<sessionId>.json` |

保存対象は、`show_markdown` で受け取った本文（最大 50 文書、各 2 MB）、このセッションで
編集した Markdown のパス、最後の選択とルートです。保持期間は 1 日、7 日、30 日から選べます。
期限切れのデータは自動的に削除されます。盾ボタンから、現在のセッションまたは保存済みの
全セッションをすぐに消去できます。保存を無効にすると、保存済みの履歴もすべて削除します。

`plan.md`、チェックポイント、`files/**` は GitHub Copilot app が管理するセッション成果物です。
SkimDown の履歴消去は、これらの原本を削除しません。

## ライセンス

SkimDown for GitHub Copilot App は [MIT License](LICENSE) で公開しています。

同梱している OSS のライセンスは
[THIRD-PARTY-NOTICES.md](.github/extensions/skimdown/THIRD-PARTY-NOTICES.md) を参照してください。
