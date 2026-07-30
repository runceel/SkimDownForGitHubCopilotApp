# Architecture Decision Records

ADR は、SkimDown canvas 拡張の**全体アーキテクチャに関する判断履歴**である。
現在の設計は [architecture.md](../architecture.md) を正とし、ADR は現状説明の代わりにしない。

## 役割分担

- `docs/architecture.md`: 常に現在の構造、境界、不変条件を示す。履歴や過去案を残さない。
- `docs/adr/NNNN-<slug>.md`: 判断時の文脈、選択肢、決定、結果を追記する。
  過去の ADR の意味を書き換えず、変更時は新しい ADR から supersede する。
- コード: 個別の内部実装の正。コードを読めば分かる関数、型、分岐、細かな手順は
  architecture.md と ADR に複製しない。

0001 から 0005 は、実装と commit history で確認できた既存判断を、2026-07-30 に
遡及記録したものである。確認できない理由を後付けしてはいない。

## ADR にする判断

次のいずれかに該当し、複数の実装箇所へ制約を与える判断を ADR にする。

- コンポーネントの責務や依存方向
- 信頼境界、origin、権限、データの隔離
- ライフサイクル、同一性、永続化スコープ
- 外部または上流コンポーネントとの互換方針
- 可用性、可観測性、運用上の不変条件
- 後から覆すコストが高く、代替案とトレードオフを共有すべき判断

局所的なリファクタリング、関数や型の設計、UI の細かな挙動、単独のバグ修正、
ライブラリの通常更新は ADR にしない。迷った場合は「コードを読めば分かるか」を問い、
分かるならコードを正とする。

## 運用

1. [0000-template.md](0000-template.md) をコピーし、次の連番と短い slug を付ける。
2. status は `Proposed`、`Accepted`、`Rejected`、`Superseded` を使う。
3. 既存判断を変更するときは、過去 ADR を編集せず新しい ADR を作り、
   新旧双方に supersede 関係を記録する。
4. ADR を追加・変更した変更セットでは、対応する `docs/architecture.md` の現状記述も更新する。
5. この索引へ ADR を追加する。
6. レビューでは、実装詳細が混入していないこと、判断理由と結果が記録されていることを確認する。

## 索引

| ADR | Status | 判断 |
| --- | --- | --- |
| [0001](0001-vendor-upstream-renderer-behind-a-compatibility-layer.md) | Superseded | 上流 renderer を変更せず、互換レイヤーの背後で利用する |
| [0002](0002-separate-ui-and-content-trust-boundaries.md) | Superseded | UI の責務分離とコンテンツの信頼境界を、frame と 2 origin で表す |
| [0003](0003-use-state-based-same-origin-renderer-communication.md) | Superseded | renderer との合意を、同一 origin の状態確認を主経路にする |
| [0004](0004-persist-bounded-renderer-diagnostics.md) | Accepted | renderer 診断を上限付き成果物として永続化する |
| [0005](0005-scope-persistent-state-by-user-session-and-document.md) | Accepted | 永続状態をユーザー、セッション、文書の同一性で分ける |
| [0006](0006-allow-bounded-local-renderer-security-hardening.md) | Accepted | 互換レイヤー背後の上流同期を維持しつつ、緊急の renderer hardening を限定的に許可する |
| [0007](0007-protect-loopback-apis-with-instance-capabilities.md) | Accepted | loopback API をインスタンス capability とブラウザー要求境界で保護する |
| [0008](0008-isolate-renderer-origin-and-capabilities.md) | Accepted | renderer を sandbox と専用 origin へ隔離し、通信と資源取得を最小権限にする |
| [0009](0009-pin-and-verify-vendored-executable-assets.md) | Accepted | vendored 実行資産の取得元と byte 列を固定して検証する |
