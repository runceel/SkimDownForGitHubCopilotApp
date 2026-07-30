# 0009: vendored 実行資産の取得元と byte 列を固定する

- Status: Accepted
- Date: 2026-07-30
- Supersedes: なし
- Superseded by: なし

## Context

canvas 拡張は checkout 後に実行されるため、同梱する JavaScript、CSS、font も実行境界の
一部である。version と license の記録だけでは、取得元の差し替え、意図しない再生成、
改行変換、レビュー対象外のファイル追加を検出できない。また、package manager による
インストールを公開時に行うと、その時点の registry と依存解決を新たな信頼境界に加える。

## Decision

vendored 実行資産は、レビュー済み上流 repository の commit を完全 SHA で固定する。
緊急の依存物修正を個別に取り込む場合は、その公式 upstream の immutable な commit を
ファイル単位で固定する。各取得元の byte 列を SHA-256 台帳で列挙し、台帳にない追加、欠落、
hash 不一致、固定取得元との不一致を CI で拒否する。依存コンポーネントの version、license、
公式配布元は台帳と生成 SBOM に記録する。

更新は固定取得元からの再取得として行い、実行時と公開物作成時には外部 package manager へ
依存しない。extension 境界と検証制御の変更は code owner のレビュー対象とし、default branch
の保護規則でそのレビューと検証 check を必須にする。

## Alternatives considered

- **version notice だけを維持する**: 同じ version 名で意図した byte 列かを証明できない。
- **repository 内の hash だけを検証する**: 台帳と資産を同時に差し替えた変更が、固定上流と
  一致するかを自動確認できない。
- **公開時に package manager から再構築する**: transitive dependency、registry、
  build toolchain を追加で信頼する必要があり、上流 renderer の byte 単位コピー方針にも合わない。

## Consequences

### Positive

- checkout、CI、再取得のいずれでも同じ資産 byte 列を確認できる。
- 意図しない追加、欠落、改行変換、上流と異なる差し替えを merge 前に検出できる。
- 公開物の依存コンポーネントと license を機械可読な形で追跡できる。

### Negative

- vendored 更新には固定取得元、component metadata、hash 台帳、SBOM の同時レビューが必要になる。
- 固定取得元が到達不能な場合、source 照合 CI は復旧まで失敗する。
- code owner 必須化は repository 側の branch protection または ruleset の継続運用を必要とする。

### Follow-up

- 公開前に default branch の保護規則と required check が有効であることを確認する。
- 上流取得方式を変更する場合も、review 済み revision と byte 単位の再現性を維持する。
