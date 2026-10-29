# 0015: Git 差分を opt-in の読み取り専用 plumbing として移植する

- Status: Accepted
- Date: 2026-10-29
- Supersedes: なし
- Superseded by: なし

## Context

上流 SkimDown v0.16.0 の Git 差分表示を canvas へ移植する。
リポジトリは信頼できない入力であり、通常の Git 状態取得には、設定から外部プログラムを
起動する経路がある。renderer へ Git 実行権限を与えたり、履歴の内容を永続化したりする
必要はない。一方、上流の macOS ホストと、この拡張が同期する Windows renderer は
構造が異なるため、上流資産の全体置換は既存の安全性・互換性を損なう。

## Decision

- 初期値オフのユーザー設定を唯一の起点とし、開いたルート自体が Git working tree の
  ルートである場合だけ、拡張プロセスが読み取り専用 plumbing を実行する。
- 実行ファイルは既知のインストール先から解決し、開いたルート配下や PATH の探索結果を
  採用しない。環境の継承を限定し、fsmonitor、lazy fetch、任意ロック、プロトコル接続を
  無効にする。処理時間、出力、比較メモリを制限する。
- `.git` がファイルの worktree / submodule では、Git が解決した外部メタデータの読み取りと
  監視だけを許す。そこを文書・画像配信の許可ルートへ昇格させない。
- Git の状態と比較元本文はインスタンス内だけに置き、本文やパスを診断へ記録しない。
  設定オフと close は監視を停止し、遅れた結果を別文書へ適用しない。
- 原作者の許可のもと、上流のブロック分類・マーカー・ガター処理を独立した補助資産として
  移植する。既存 renderer への接続はトークン生成と描画ライフサイクルに限定し、
  サニタイズ、origin 分離、リモートコンテンツ許可は変えない。

## Alternatives considered

- `git status` / `git diff`: fsmonitor、フィルター、external diff を実行し得るため使わない。
- `.git` を独自解析する: worktree、submodule、オブジェクト形式、ignore の互換性を
  拡張側が再実装することになるため採用しない。
- macOS renderer 全体の置換: Windows 由来のホスト契約と既存 hardening を維持できない。
- 上流の色・レイアウトの無改変コピー: canvas のホストテーマと本文内側の余白へ適合しない。

## Consequences

### Positive

- 既存の読み取り専用境界を維持し、差分表示だけを明示的に有効化できる。
- 上流由来の表示処理と canvas 固有の統合を区別してレビューできる。

### Negative

- 標準的でない場所にしか Git がない環境では、通常表示を維持しつつ利用不可を通知する。
- 大きく異なる文書では、比較メモリの上限を守るため変更範囲の分類が粗くなる。
- 補助資産と renderer の最小限の接続箇所を、今後の上流同期時にも維持する必要がある。

### Follow-up

現在の境界と不変条件は [architecture.md](../architecture.md) に反映する。
