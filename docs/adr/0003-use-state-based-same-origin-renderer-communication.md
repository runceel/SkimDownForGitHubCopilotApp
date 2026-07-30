# 0003: renderer との合意を同一 origin の状態確認を主経路にする

- Status: Superseded
- Date: 2026-07-30
- Supersedes: なし
- Superseded by: [0008](0008-isolate-renderer-origin-and-capabilities.md)

## Context

renderer は起動完了を 1 回だけ通知し、シェルは完了後に文書やテーマを送る。単発通知が
listener の準備前、frame の入れ替え中、または renderer の早期障害で失われると、
シェルは準備状態を判定できず、表示が永久に空のままになる。

シェルと renderer は同一 origin にあるため、通知の到着履歴ではなく、renderer の現在状態を
直接確認できる。

## Decision

シェルと renderer の主通信経路は、同一 origin の直接呼び出しと状態問い合わせにする。
準備完了は「通知を受信したか」ではなく、「renderer が現在準備済みか」で判定する。

配送は上流ホスト契約と同じ非同期性を保つ。`postMessage` は、直接ハンドルが利用できない
場合のフォールバックとして維持するが、正しい起動を単発 message の受信だけに依存させない。

## Alternatives considered

- **`postMessage` の単発通知だけを使う**: listener timing と frame lifecycle に依存し、
  取りこぼし後の回復手段がないため採用しない。
- **ack と再送を追加する**: 改善はするが、双方の message listener が正常であることへ
  依存し続けるため主経路にはしない。
- **常に cross-origin transport を使う**: 現在の信頼モデルに不要な複雑さを加え、
  利用できる状態確認能力を捨てるため採用しない。

## Consequences

### Positive

- listener の準備順や単発 message の損失から回復できる。
- renderer が通知できなくても、起動済み状態をシェルが採用できる。
- 直接経路が失敗しても message transport へ退避できる。

### Negative

- シェルと renderer を同一 origin に置くことが、可用性設計の明示的な前提になる。
- 将来 cross-origin 化する場合は、状態照会を含む通信契約全体の再設計が必要になる。

### Follow-up

- renderer の起動条件を増やす場合も、準備状態を外部から問い合わせ可能に保つ。
