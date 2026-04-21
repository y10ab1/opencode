import { Button } from "@opencode-ai/ui/button"
import { Splash } from "@opencode-ai/ui/logo"
import { TextField } from "@opencode-ai/ui/text-field"
import { showToast } from "@opencode-ai/ui/toast"
import { createSignal, Match, Show, Switch } from "solid-js"
import { useGlobalSync } from "@/context/global-sync"

type Step = "welcome" | "apikey" | "done"

export function SetupWizard(props: { onComplete: () => void }) {
  const [step, setStep] = createSignal<Step>("welcome")
  const [apiKey, setApiKey] = createSignal("")
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal("")
  const [autoReport, setAutoReport] = createSignal(true)
  const globalSync = useGlobalSync()

  const saveApiKey = async () => {
    const key = apiKey().trim()
    if (!key) {
      setError("請輸入 API Key")
      return
    }

    setSaving(true)
    setError("")

    try {
      await globalSync.updateConfig({
        provider: {
          "llm-proxy": {
            npm: "@ai-sdk/anthropic",
            name: "LLM API Proxy",
            options: {
              baseURL: "https://llm-api-proxy.gamaniaocc.org/v1",
              apiKey: key,
            },
            models: {
              "claude-sonnet-4-6": {
                name: "Claude Sonnet 4.6",
                limit: {
                  context: 200000,
                  output: 65536,
                },
              },
            },
          },
        },
        model: "llm-proxy/claude-sonnet-4-6",
      })

      showToast({ variant: "success", title: "API Key 設定成功！" })
      setStep("done")
    } catch (err) {
      console.error("Failed to save API key", err)
      setError("儲存失敗，請確認 Key 是否正確後重試")
    } finally {
      setSaving(false)
    }
  }

  const finish = async () => {
    try {
      if (autoReport()) {
        await window.api?.setupAutoReports?.(true)
      }
      await window.api?.completeSetup?.()
    } catch {}
    props.onComplete()
  }

  return (
    <div class="h-dvh w-screen flex flex-col items-center justify-center bg-background-base">
      <div class="max-w-md w-full px-6">
        <Switch>
          <Match when={step() === "welcome"}>
            <div class="flex flex-col items-center text-center gap-6">
              <Splash class="w-16 h-20" />
              <div class="flex flex-col gap-2">
                <h1 class="text-xl font-semibold text-text-strong">歡迎使用 AI 助手</h1>
                <p class="text-14-regular text-text-base">
                  你的專屬 AI 助手，可以幫你回答問題、翻譯文字、整理資料、草擬訊息等。
                </p>
              </div>
              <div class="flex flex-col gap-2 w-full text-left bg-surface-base rounded-lg p-4">
                <p class="text-13-medium text-text-strong">你可以使用以下功能：</p>
                <ul class="text-13-regular text-text-base space-y-1">
                  <li>
                    <span class="text-text-strong font-mono">/summarize</span> — 摘要整理
                  </li>
                  <li>
                    <span class="text-text-strong font-mono">/translate</span> — 中英互譯
                  </li>
                  <li>
                    <span class="text-text-strong font-mono">/line-reply</span> — 草擬 LINE 回覆
                  </li>
                  <li>
                    <span class="text-text-strong font-mono">/daily-report</span> — 今日工作報告
                  </li>
                  <li>
                    <span class="text-text-strong font-mono">/weekly-report</span> — 本週工作週報
                  </li>
                </ul>
              </div>
              <Button size="large" class="w-full" onClick={() => setStep("apikey")}>
                開始設定
              </Button>
            </div>
          </Match>

          <Match when={step() === "apikey"}>
            <div class="flex flex-col items-center text-center gap-6">
              <Splash class="w-12 h-15" />
              <div class="flex flex-col gap-2">
                <h1 class="text-xl font-semibold text-text-strong">設定 API Key</h1>
                <p class="text-14-regular text-text-base">請輸入你收到的 API Key（一串英數字組成的密碼）</p>
              </div>
              <div class="w-full flex flex-col gap-3">
                <TextField
                  placeholder="貼上你的 API Key..."
                  value={apiKey()}
                  onChange={(val) => {
                    setApiKey(val)
                    setError("")
                  }}
                />
                <Show when={error()}>
                  <p class="text-12-regular text-danger-base">{error()}</p>
                </Show>
                <Button size="large" class="w-full" onClick={() => void saveApiKey()} disabled={saving() || !apiKey().trim()}>
                  {saving() ? "設定中..." : "確認"}
                </Button>
                <button
                  type="button"
                  class="text-13-regular text-text-weak hover:text-text-base transition-colors"
                  onClick={() => setStep("welcome")}
                >
                  返回
                </button>
              </div>
            </div>
          </Match>

          <Match when={step() === "done"}>
            <div class="flex flex-col items-center text-center gap-6">
              <div class="w-16 h-16 rounded-full bg-success-base/10 flex items-center justify-center">
                <svg class="w-8 h-8 text-success-base" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </div>
              <div class="flex flex-col gap-2">
                <h1 class="text-xl font-semibold text-text-strong">設定完成！</h1>
                <p class="text-14-regular text-text-base">你可以開始使用 AI 助手了。</p>
              </div>
              <div class="flex flex-col gap-2 w-full text-left bg-surface-base rounded-lg p-4">
                <p class="text-13-medium text-text-strong">小提示：</p>
                <ul class="text-13-regular text-text-base space-y-1">
                  <li>
                    用 <span class="font-mono text-text-strong">Tab</span> 鍵切換不同助手（通用 / 文字 / LINE）
                  </li>
                  <li>
                    輸入 <span class="font-mono text-text-strong">/</span> 查看所有快捷指令
                  </li>
                  <li>
                    每天下班前打 <span class="font-mono text-text-strong">/daily-report</span> 產日報
                  </li>
                </ul>
              </div>
              <label class="flex items-center gap-3 w-full bg-surface-base rounded-lg p-4 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={autoReport()}
                  onChange={(e) => setAutoReport(e.currentTarget.checked)}
                  class="w-4 h-4 accent-brand-base"
                />
                <div class="text-left">
                  <p class="text-13-medium text-text-strong">啟用自動日報 / 週報</p>
                  <p class="text-12-regular text-text-weak">每天下午 6 點自動產日報，每週五自動產週報</p>
                </div>
              </label>
              <Button size="large" class="w-full" onClick={() => void finish()}>
                開始使用
              </Button>
            </div>
          </Match>
        </Switch>
      </div>
    </div>
  )
}
