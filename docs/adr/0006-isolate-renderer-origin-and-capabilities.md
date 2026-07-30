# 0006: renderer を専用 origin と sandbox へ隔離する

- Status: Accepted
- Date: 2026-07-30
- Supersedes: [0002](0002-separate-ui-and-content-trust-boundaries.md), [0003](0003-use-state-based-same-origin-renderer-communication.md)
- Superseded by: なし

## Context

renderer は信頼されたコードだが、信頼できない Markdown を処理する。シェルと renderer を
同一 origin に置くと、サニタイズや renderer の欠陥でスクリプト実行に至った場合に、
状態 API とシェルへ同一 origin 権限で到達できる。

同一 origin の直接状態確認は起動合意を安定させる一方、権限分離と両立しない。また、
資源取得を制約するポリシーがなければ、意図しない外部接続やコード実行をブラウザー側で
抑止できない。権限を分けても、準備完了通知の取りこぼしから回復できる必要がある。

## Decision

シェルと状態 API、renderer の実行資産、文書メディアを、それぞれ別の loopback origin に
置く。renderer origin は静的なレンダリング資産だけを提供し、状態 API やシェル資産を
提供しない。renderer frame は sandbox 化し、シェルとの直接 DOM・JavaScript アクセスを
許可しない。

シェルと renderer の通信は、送信元 window、origin、封筒、許可したメッセージ種別を検証する
`postMessage` 契約だけに限定する。準備状態は、シェルが冪等な問い合わせを再送し、renderer が
現在状態で応答することで確認する。診断も同じ契約でシェルへ渡し、renderer から状態 API への
接続は許可しない。

各 origin は `default-src 'none'` を基点とする役割別 CSP を HTTP header で配信する。
renderer は同一 origin のスクリプト、スタイル、フォントと、専用コンテンツ origin の画像だけを
取得できる。すべての応答に MIME sniffing 防止と origin 間資源ポリシーを適用する。

## Alternatives considered

- **同一 origin のまま CSP だけ追加する**: 外部接続は制限できるが、renderer からシェルと
  状態 API への同一 origin 権限が残るため採用しない。
- **renderer に状態 API への CORS 接続を許可する**: 診断には便利だが、隔離領域へ不要な
  接続権限を戻すため採用しない。
- **準備完了を単発 `postMessage` だけで通知する**: listener の準備順や frame 再読込で
  取りこぼすと回復できないため採用しない。
- **renderer を opaque origin にする**: さらに強い隔離になるが、専用静的 origin の
  厳密な送信元検証と資産互換性を失うため採用しない。

## Consequences

### Positive

- Markdown 処理領域でスクリプト実行が起きても、シェルと状態 API の同一 origin 権限を持たない。
- renderer のコード取得、接続、画像取得先をブラウザーが強制する。
- 通信契約が明示的になり、renderer から実行できるシェル操作を限定できる。
- cross-origin 化しても、再送可能な準備確認により単発通知へ依存しない。

### Negative

- canvas インスタンスごとに 3 つの server lifecycle を管理する。
- renderer が必要とする資源種別を増やす場合、CSP と origin 境界の見直しが必要になる。
- same-origin の直接診断は使えず、隔離境界を越える診断項目は明示的な契約が必要になる。

### Follow-up

- renderer の資源やメッセージ種別を追加するときは、既存の許可範囲を広げる必要性を評価する。
