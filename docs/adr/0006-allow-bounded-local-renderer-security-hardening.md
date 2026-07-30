# 0006: 上流 renderer に緊急 hardening の限定的な例外を設ける

- Status: Accepted
- Date: 2026-07-30
- Supersedes: [0001](0001-vendor-upstream-renderer-behind-a-compatibility-layer.md)
- Superseded by: なし

## Context

上流 renderer を変更せず同期する方針は、canvas 固有の fork と継続的な挙動差を防いでいる。
一方、renderer は信頼できない Markdown とアセット origin の live DOM の境界を担うため、
上流の修正版を待つ間も既知の脆弱性を公開状態にしておくことはできない。

互換レイヤーで入力や DOM API を横取りすると上流のレンダリング責務が境界外へ漏れ、
セキュリティ上重要な順序が複数コンポーネントへ分散する。安全性を優先しつつ、恒久的な
canvas fork を避ける運用上の制約が必要である。

## Decision

renderer 本体、スタイル、ベンダー資産は引き続き上流同期を原則とし、canvas 固有の差異は
互換レイヤーと外側のシェルで吸収する。互換レイヤーは実行環境の既存 host object を壊さず、
上流 renderer が期待する契約を提供する。

ただし、安全な上流リビジョンを待てない renderer の脆弱性には、信頼境界を直接修復する
最小限のローカル hardening patch を許可する。

例外 patch は悪性入力の回帰テストを伴い、canvas 固有機能を追加しない。対応する上流修正が
利用可能になった時点で差分を解消し、上流コピーへ戻す。スタイルと第三者ベンダー資産には
この例外を広げない。

## Alternatives considered

- **上流修正まで公開を継続する**: 既知の脆弱性をアセット origin で実行可能な状態に残すため
  採用しない。
- **互換レイヤーで危険な経路を迂回する**: renderer の信頼境界と処理順序が複数箇所へ分散し、
  上流変更で迂回が無効になる危険があるため採用しない。
- **canvas 専用 renderer として恒久的に fork する**: 機能差と二重保守が恒常化するため採用しない。

## Consequences

### Positive

- 上流のリリース時期に依存せず、既知の renderer 脆弱性を閉じられる。
- セキュリティ上重要な処理順序を renderer の信頼境界内に保てる。
- 回帰テストが、上流再同期時にも同じ安全性を要求する。

### Negative

- 例外 patch が存在する間は、上流とのバイト単位一致を失う。
- 上流更新時に patch の採用状況を確認し、差分を解消する作業が必要になる。

### Follow-up

- 現在設計に、未サニタイズ DOM を live document へ入れない不変条件と例外 patch の運用を反映する。
- 上流に同等の修正が入った後、回帰テストを維持したまま renderer を再同期する。
