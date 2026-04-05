# Types Naming Style

## Summary

このドキュメントは、`src/types`、`src/api`、`src/matrix/application` で使う型名・Schema名・Error名の命名規則を固定する。

目的は次の 3 点。

- 型の役割を名前だけで判別できるようにする
- `api` と `application` の境界を名前で見分けられるようにする
- `types` の統廃合と再配置を進めやすくする

## Core Rule

- 名前は `実装手段` ではなく `役割` で決める
- 同じ suffix は同じ意味にだけ使う
- `Request` と `Input`、`Response` と `Result`、`State` と `Record` を混ぜない

## Approved Suffixes

- `*Request`
  - HTTP request body/query/path を表す DTO
  - 外部から受ける wire shape
- `*Response`
  - HTTP response body を表す DTO
- `*Input`
  - use-case/application service への入力
- `*Result`
  - use-case/application 処理結果
- `*State`
  - 現在状態、接続状態、workflow 状態、購読状態
- `*Record`
  - DB row、KV row、serialized storage row
- `*Event`
  - event-like payload、client-facing event view
- `*Content`
  - Matrix event content 本体
- `*Envelope`
  - wrapper payload、federation wrapper、transport wrapper
- `*Context`
  - ambient input bundle、visibility bundle、execution context
- `*Port`
  - external dependency interface
- `*Policy`
  - authorization/rule set/policy object
- `*Schema`
  - Effect Schema

## Disallowed Or Discouraged Suffixes

- `*Data`
  - 意味が広すぎるので原則使わない
- `*Info`
  - 境界が曖昧なので原則使わない
- `*Object`
  - TypeScript では抽象度が高すぎるので使わない
- `*Payload`
  - 便利すぎて曖昧になりやすいので原則避ける
  - 使う場合は wire payload 限定

## Name Semantics

- `Request`
  - endpoint/request parse の入力形
- `Input`
  - application/use-case へ渡す整形後入力
- `Response`
  - endpoint が返す JSON 形
- `Result`
  - application 内の処理結果
- `State`
  - 接続・同期・partial-state の現在状態
- `Record`
  - ストレージや query result の単位
- `Event`
  - event-like view
- `Content`
  - event の `content`

## Field Naming

- internal DTO field は `camelCase`
- Matrix spec/wire shape は `snake_case` を維持してよい
- spec/wire DTO を無理に `camelCase` へ変換しない

例:

- internal: `userId`, `roomId`, `eventId`
- Matrix wire: `user_id`, `room_id`, `event_id`

## Placement Rules

- `src/api`
  - endpoint 実装を置く
  - route に残すのは request 読み取り、decode、use-case 呼び出し、response mapping
- `src/types`
  - 共通 DTO、state、schema、error shape を置く
- `src/matrix/application/features/*`
  - feature-local contract、port、policy、service を置く

## Examples

- `SyncUserInput`
  - 良い。use-case input
- `SlidingSyncRequest`
  - 良い。HTTP request
- `FederationTransactionEnvelope`
  - 良い。wrapper payload
- `ConnectionState`
  - 良い。state snapshot
- `ClientRoomEvent`
  - 良い。client-facing event view
- `CreateRoomRequestSchema`
  - 良い。Effect Schema

## Migration Guidance

- 新しい型を追加する時は、まず suffix を決める
- suffix が決まらない型は、境界が曖昧な可能性が高いので再検討する
- rename では次を優先する
  - `Request` と `Input` の分離
  - `Response` と `Result` の分離
  - `State` と `Record` の分離
  - `Event` と `Content` の分離
