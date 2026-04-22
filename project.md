# OpenCode 非技術人員適配專案

## 專案概述

將 [y10ab1/opencode](https://github.com/y10ab1/opencode/tree/dev) fork 改造，讓不會 coding 的同事可以直接安裝 Desktop App 使用 AI 助手。

同事的完整流程：安裝 App → 打開 → 輸入 API Key → 開始用。

## 架構

所有自定義配置（agents / commands / instructions）打包在 Desktop App 中，首次啟動時自動部署到 `~/.config/opencode/`。Setup Wizard 在 app 內引導同事輸入 API Key。

### 技術棧

- **Desktop App**: Electron + SolidJS（`packages/desktop-electron`）
- **Frontend**: SolidJS（`packages/app`）
- **Core Engine**: `packages/opencode`（不修改）
- **LLM Provider**: 公司 LLM Proxy（`@ai-sdk/anthropic`，透傳 Anthropic 原生 API）

> **重要**：公司 proxy（`llm-api-proxy.gamaniaocc.org`）返回的是 **Anthropic 原生 API 格式**，不是 OpenAI-compatible 格式。因此 `npm` 必須設為 `@ai-sdk/anthropic`，`baseURL` 設為 `https://llm-api-proxy.gamaniaocc.org/v1`。這樣 prompt caching、reasoning/thinking 等 Claude 原生功能都可以正常使用。

## 改動的檔案

### 新增檔案

| 路徑 | 說明 |
|---|---|
| `packages/desktop-electron/resources/opencode-defaults/config.json` | 全域配置（provider、model、permission） |
| `packages/desktop-electron/resources/opencode-defaults/instructions.md` | 全域 system prompt |
| `packages/desktop-electron/resources/opencode-defaults/agents/assistant.md` | 通用助手 agent |
| `packages/desktop-electron/resources/opencode-defaults/agents/writer.md` | 文字助手 agent |
| `packages/desktop-electron/resources/opencode-defaults/agents/line-helper.md` | LINE 溝通助手 agent |
| `packages/desktop-electron/resources/opencode-defaults/commands/setup.md` | /setup 修改 API Key |
| `packages/desktop-electron/resources/opencode-defaults/commands/summarize.md` | /summarize 摘要 |
| `packages/desktop-electron/resources/opencode-defaults/commands/translate.md` | /translate 翻譯 |
| `packages/desktop-electron/resources/opencode-defaults/commands/line-reply.md` | /line-reply LINE 回覆 |
| `packages/desktop-electron/resources/opencode-defaults/commands/daily-report.md` | /daily-report 日報 |
| `packages/desktop-electron/resources/opencode-defaults/commands/weekly-report.md` | /weekly-report 週報 |
| `packages/app/src/components/setup-wizard.tsx` | Setup Wizard UI 元件 |

### 修改檔案

| 路徑 | 說明 |
|---|---|
| `packages/desktop-electron/electron-builder.config.ts` | 新增 extraResources 打包 opencode-defaults |
| `packages/desktop-electron/src/main/constants.ts` | 新增 HAS_COMPLETED_SETUP_KEY 常數 |
| `packages/desktop-electron/src/main/index.ts` | 首次執行偵測 + deployBundledConfigs + setupAutoReports |
| `packages/desktop-electron/src/main/ipc.ts` | 新增 completeSetup / setupAutoReports IPC handler |
| `packages/desktop-electron/src/main/store.ts` | （未修改結構，透過現有 getStore 使用） |
| `packages/desktop-electron/src/preload/types.ts` | WindowConfig 加 isFirstRun、ElectronAPI 加新方法 |
| `packages/desktop-electron/src/preload/index.ts` | 新增 completeSetup / setupAutoReports preload bridge |
| `packages/desktop-electron/src/renderer/index.tsx` | 傳遞 isFirstRun 到 AppInterface |
| `packages/app/src/app.tsx` | AppInterface 加 isFirstRun prop + first-run gate |

## 配置說明

### 全域配置位置

`~/.config/opencode/`（macOS/Linux）或 `%APPDATA%/opencode/`（Windows）

### Permission 設定

- `read` / `websearch` / `webfetch`: 直接允許
- `edit` / `bash` / `*`: 每次詢問使用者確認

### 停用的 Agent

- `build`、`plan`、`explore`（coding 專用，非技術同事不需要）

### 可用的自定義 Agent

- `assistant`（預設）：通用 AI 助手
- `writer`：文字工作助手
- `line-helper`：LINE 溝通助手

### 可用的 Command

- `/summarize`：摘要整理
- `/translate`：中英互譯
- `/line-reply`：草擬 LINE 回覆
- `/daily-report`：今日工作報告
- `/weekly-report`：本週工作週報
- `/setup`：修改 API Key

## 自動日報/週報

Setup Wizard 結束時可選「啟用自動日報/週報」：
- macOS/Linux：寫入 crontab（每天 18:00 日報、每週五 18:00 週報）
- Windows：建立 Task Scheduler 排程

使用 `opencode run --command daily-report` 非互動式執行。

## 開發與建構

```bash
# 開發
cd packages/desktop-electron
bun run dev

# 打包（會自動帶入 opencode-defaults 資源）
bun run package
```

CI/CD 由 `.github/workflows/publish.yml` 自動建構 Mac / Windows / Linux 三平台。
