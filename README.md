# py_devtools

自然言語の指示で Chrome を自動操作するツール群です。

現在はローカル（CLI）で動作します。次の段階として、Chrome 拡張機能から同じ操作を行えるようにする予定です。

## 現状（Phase 1）: ローカル CLI

Gemini CLI と [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) を使い、CDP で起動した Chrome を自然言語で操作します。

```text
あなた（自然言語）
    ↓
run_gemini_chrome.py / run-gemini-chrome.ps1
    ↓
Gemini CLI + chrome-devtools MCP
    ↓
Chrome（CDP: 127.0.0.1:9222, 専用プロファイル）
```

### できること

- 「DuckDuckGo で AI を検索して最初の結果を開き、要約して」のような指示でブラウザを操作
- 専用プロファイル（`chrome-profile/`）を使うため、ログイン状態を維持したまま操作可能
- エージェントの振る舞いは `.gemini/GEMINI.md` で調整

### 必要なもの

- Windows + Google Chrome
- Python 3
- Node.js（`npx` / Gemini CLI 用）
- [Gemini CLI](https://github.com/google-gemini/gemini-cli)（`npm install -g @google/gemini-cli`）
- Gemini API キー

### セットアップ

1. `.env.example` をコピーして `.env` を作り、`GEMINI_API_KEY` を設定する。

```powershell
copy .env.example .env
```

2. Gemini CLI をインストールする。

```powershell
npm install -g @google/gemini-cli
```

### 使い方

Chrome の起動と Gemini による操作をまとめて実行:

```powershell
.\run-gemini-chrome.ps1 --prompt "現在開いてるchromeで、duckduckgoでAIを検索して、最初のページを開き、内容を要約して"
```

モデルを指定する場合:

```powershell
.\run-gemini-chrome.ps1 --model gemini-3.5-flash-lite --prompt "開いているタブの内容を要約して"
```

すでに CDP で Chrome が起動している場合:

```powershell
.\run-gemini-chrome.ps1 --skip-chrome --prompt "..."
```

Chrome だけ先に起動する場合:

```powershell
.\start-chrome-cdp.ps1
```

### 主なファイル

| ファイル | 役割 |
|---|---|
| `run_gemini_chrome.py` | Chrome（CDP）起動 + Gemini CLI 実行 |
| `run-gemini-chrome.ps1` | 上記の PowerShell ラッパー |
| `start-chrome-cdp.ps1` | CDP 付き Chrome のみ起動 |
| `.gemini/settings.json` | chrome-devtools MCP の設定 |
| `.gemini/GEMINI.md` | エージェントへの常設指示 |
| `.env.example` | `.env` のサンプル（API キー・CDP 設定） |
| `.env` | API キー・CDP 設定（Git 管理外） |
| `chrome-profile/` | 専用 Chrome プロファイル（Git 管理外） |

### オプション

| オプション | 説明 |
|---|---|
| `--prompt` | 自然言語の指示（必須） |
| `--model` | Gemini モデル（既定: `gemini-3.5-flash-lite`） |
| `--skip-chrome` | Chrome を起動せず、既存 CDP に接続 |
| `--cdp-host` / `--cdp-port` | CDP のホスト・ポート |
| `--system-prompt-file` | Gemini CLI のシステムプロンプトをファイルで完全置換 |

常設の振る舞い変更は `.gemini/GEMINI.md` の編集を推奨します。

## 次の予定（Phase 2）: Chrome 拡張機能

Chrome 拡張機能を作り、拡張の UI に自然言語を書くとブラウザを自動操作できるようにします。

### 目指す体験

1. 拡張のポップアップ（またはサイドパネル）に日本語で指示を書く
2. バックエンド（またはローカルエージェント）が指示を解釈する
3. 現在のタブ／ページを自動操作し、結果を返す

### 想定アーキテクチャ（検討中）

```text
Chrome 拡張（入力 UI）
    ↓  自然言語プロンプト
ローカルエージェント / API
    ↓  ブラウザ操作コマンド
Chrome（拡張 API または CDP）
```

Phase 1 で固めた「自然言語 → ブラウザ操作」の流れを、拡張の UI から呼び出せる形に移植する方針です。

## 注意

- `.env` と `chrome-profile/` は秘密情報・セッションを含むためコミットしない
- エージェントはログイン済みセッションを壊さない前提（ログアウトや設定変更はしない）
- CDP（リモートデバッグ）はローカル開発用途。外部公開しない
