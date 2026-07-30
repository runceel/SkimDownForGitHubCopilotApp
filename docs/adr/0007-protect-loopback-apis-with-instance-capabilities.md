# 0007: loopback API をインスタンス capability とブラウザー要求境界で保護する

- Status: Accepted
- Date: 2026-07-30
- Supersedes: なし
- Superseded by: なし

## Context

loopback への bind は外部ネットワークからの到達を防ぐが、同じ端末上の別プロセス、
悪性 Web ページからの cross-origin 要求、DNS rebinding を防ぐ認証境界にはならない。
アセット origin の API とイベントストリームは、文書選択、設定変更、ローカルファイルの
読み取りへ到達するため、ポート番号を知っているだけの要求を canvas インスタンスとして
信頼できない。

一方、canvas はインスタンスごとに一時的な URL をホストへ返せる。シェルと renderer は
同一 origin にあり、インスタンスの寿命だけ有効な秘密を共有できる。

## Decision

canvas インスタンスの起動ごとに暗号学的に安全な capability を生成し、そのインスタンスの
API とイベントストリームに必須とする。capability は永続化せず、パネル URL の fragment
を通じて信頼されたシェルへ渡し、通常の HTTP navigation や referrer へ含めない。

アセット origin は、capability に加えて次の境界をすべて検証する。

- 宛先 Host は、起動した server の loopback address と port に完全一致する。
- ブラウザーが報告する Origin と Fetch Metadata は同一 origin の要求を示す。
- 状態を変更する要求は JSON に限定し、simple request による CSRF を許さない。

ローカルファイル操作は、workspace、セッション成果物、セッション一覧へ登録された文書、
またはユーザーかホストが明示的に開いた root の内側だけを対象にする。表示一覧からの選択も
server 側でこの許可範囲を再検証する。

## Alternatives considered

- **loopback bind とランダム port だけに依存する**: port は認証情報ではなく、同一端末の
  プロセスや probing する Web ページに対する防御にならないため採用しない。
- **CORS のみを使う**: 応答の読み取りは制限できても、simple request の送信、DNS rebinding、
  ローカルプロセスを一括して防げないため採用しない。
- **cookie で認証する**: browser の ambient authority になり CSRF 境界が弱く、複数 port の
  instance 分離も明示的でなくなるため採用しない。
- **すべての任意パスを API から選択可能にする**: path を知る要求がそのままファイル読取権限を
  得るため採用しない。

## Consequences

### Positive

- 別の Web origin、DNS rebinding、capability を持たないローカルプロセスからの操作を拒否できる。
- canvas インスタンス間で権限が分離され、close とともに capability も失効する。
- ファイル一覧の値を改変した要求でも、承認済み範囲の外を読み取れない。

### Negative

- シェルと renderer のすべての API/SSE 経路で capability を引き回す必要がある。
- browser metadata を送らない汎用 HTTP client は、capability を持っていても API を利用できない。
- 任意パスを開く操作には、承認済み root を増やす明示的な操作が必要になる。

### Follow-up

- 新しい API、イベント経路、ローカルファイル操作を追加するときも、同じ認証と許可範囲を適用する。
