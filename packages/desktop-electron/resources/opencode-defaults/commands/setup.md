---
description: "修改 API Key 設定"
---

請幫使用者更新 API Key。步驟：

1. 問使用者：「請輸入新的 API Key：」
2. 讀取 ~/.config/opencode/config.json
3. 將 provider.llm-proxy.options.apiKey 的值更新為使用者輸入的 key
4. 寫回 config.json
5. 告訴使用者：「API Key 已更新！請重啟 App 以套用新設定。」

$ARGUMENTS
