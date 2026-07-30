# 0002: UI の責務分離とコンテンツの信頼境界を frame と 2 origin で表す

- Status: Accepted
- Date: 2026-07-30
- Supersedes: なし
- Superseded by: なし

## Context

canvas には、拡張が信頼するナビゲーション UI と実行コード、信頼できない Markdown 入力、
Markdown から参照されるローカルメディアが共存する。これらを 1 つの文書と origin に置くと、
UI の責務とレンダリングの責務が混ざり、コンテンツ由来資源が状態 API と同じ権限領域に入る。

同時に、上流 renderer は独立した文書として動かした方が、ホスト互換境界を明確に保てる。

## Decision

外側のシェルを信頼された chrome UI、内側の frame を上流 renderer の実行領域とする。
両者は責務分離のために frame で分けるが、可用性のため同一のアセット origin に置く。

アセット origin と、ローカルメディアを提供するコンテンツ origin は分離する。両サーバーは
loopback のみに公開する。コンテンツ origin は、選択文書のディレクトリ配下かつ許可した
メディア種別だけを提供し、アセット、状態 API、任意のローカルファイルを提供しない。

信頼できない Markdown は renderer のサニタイズ経路を必ず通す。

## Alternatives considered

- **UI と renderer を 1 つの文書へ統合する**: 上流資産との境界が失われ、
  シェルとレンダリング規則が密結合になるため採用しない。
- **すべてを 1 origin から提供する**: コンテンツ由来資源と特権 UI/API の信頼境界が
  消えるため採用しない。
- **シェルと renderer も cross-origin にする**: ブラウザーの隔離は強まるが、
  現在状態を直接確認できず、起動合意の可用性を損なうため採用しない。

## Consequences

### Positive

- UI、レンダリング、ローカルコンテンツ配信の責務が明確になる。
- ローカルメディアが、信頼された UI/API と同じ origin の権限を得ない。
- 上流 renderer を独立文書として保ちながら、シェルとの確実な状態確認が可能になる。

### Negative

- canvas インスタンスごとに 2 つの server lifecycle を管理する必要がある。
- 入れ子 frame 自体はセキュリティ境界ではないため、サニタイズと content origin の制約を
  別途維持しなければならない。

### Follow-up

- 新しいコンテンツ種別を扱う場合は、content origin の許可範囲を拡大する必要性と危険性を
  アーキテクチャ判断として評価する。
