# opentunnel-mcp

OpenTunnel（https://opentunnel.xyz、anomalyco 製の blind TLS トンネル）を MCP から
操作するサーバー。ローカルポートを `https://<name>.<id>.opentunnel.xyz` で公開し、
その公開 URL を返す。

公式の opentunnel CLI には MCP 機能が無く、Windows バイナリも無い（Linux/macOS のみ）。
そのため公式 TypeScript SDK **`@opentunnel/client`** をラップして実装した（Node ≥22 で
ネイティブ動作。`effect` が peer dependency）。

## ツール

| ツール | 機能 |
|---|---|
| `status` | トンネル識別情報（hostname）、接続状態、routes と公開 URL、直近イベント |
| `expose` | ローカルポート（または `target`）を公開して公開 URL を返す。既存 routes に **マージ**。`name` 省略時はランダム 16 進（推測不能 URL）。`proxy_protocol` v1/v2 対応 |
| `set_routes` | routes を **全置換**（CLI の config 手編集相当）。`{}` で全解除（接続は維持） |
| `close` | bridge 切断。routes はクリア、識別情報（hostname）は保存されて再利用される |
| `delete_tunnel` | トンネルを完全削除（hostname 失効）。`confirm: true` 必須 |

## 挙動の注意

- **トンネルの寿命 = MCP プロセスの寿命**。opencode が MCP を殺すと bridge も切れる
  （CLI の systemd/launchd 常駐サービスは Windows に無いため）。opencode 再起動後は
  `expose` を呼べば保存済み identity で即復帰する（証明書の再発行は不要）
- 初回の `expose` はトンネル作成 + ZeroSSL 証明書発行で 1 分程度かかることがある
  （opencode.jsonc 側で `timeout: 180000` を設定済み）
- route 名は 1 つの小文字 DNS ラベル。`@` でトンネル hostname 自体
- route は 1 bridge が占有。CLI 等の別プロセスが同じ route を持つと `route_conflict`
  （相手が消えるまでリトライして引き取る）
- 開発サーバ等ループバック以外の bind は不可ではないが、trust boundary 的に
  ループバック向け（docs/trust-boundary.md）

## ファイル / identity

identity（証明書・鍵・トークン）は `~/.local/share/opentunnel/default/`（Windows では
ユーザープロファイル直下の `.local\share\opentunnel\`）に保存される
（`tunnel.json` / `token` / `private-key.pem` / `certificate.pem` / `chain.pem`）。
**コミット禁止**。hostname は `<id>.opentunnel.xyz` 形式。

## テスト

```powershell
node test/e2e.mjs   # 実トンネルを張り、公開 URL を実際に fetch して 200 を確認
```

ローカル HTTP サーバをランダムポートで立て、MCP stdio プロトコル（NDJSON）で
initialize → expose → fetch → status → set_routes({}) → close まで一気に検証する。

## opencode への登録（済・2026-11-19）

`~/.config/opencode/opencode.jsonc` の `mcp` に登録:

```jsonc
"opentunnel": {
  "type": "local",
  "command": ["node", "<workspace>/mcp/opentunnel-mcp/index.js"],
  "timeout": 180000,
  "enabled": true
}
```

opencode は設定変更をホットリロードした（新セッションでも自動で読み込まれる）。

## 構成

```
index.js        MCP サーバ本体（単一ファイル・ESM・ビルド不要）
test/e2e.mjs    実トンネル E2E
package.json    deps: @opentunnel/client, effect, @modelcontextprotocol/sdk, zod
```

node_modules は `bun install` で導入（npm は当時ネットワーク不調で断念）。

## 関連

- 公式: https://github.com/anomalyco/opentunnel （SDK: packages/client）
- 同型の台帳: `ngrok-mcp`（ngrok 公式リモート MCP の台帳）
