import { randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs"
import { execFile as execFileCb } from "node:child_process"
import { createServer } from "node:net"
import { homedir, platform } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import type { Event } from "electron"
import { app, BrowserWindow, dialog } from "electron"
import pkg from "electron-updater"

const execFileAsync = promisify(execFileCb)

import contextMenu from "electron-context-menu"
contextMenu({ showSaveImageAs: true, showLookUpSelection: false, showSearchWithGoogle: false })

// on macOS apps run in `/` which can cause issues with ripgrep
try {
  process.chdir(homedir())
} catch {}

process.env.OPENCODE_DISABLE_EMBEDDED_WEB_UI = "true"

const APP_NAMES: Record<string, string> = {
  dev: "OpenCode Dev",
  beta: "OpenCode Beta",
  prod: "OpenCode",
}
const APP_IDS: Record<string, string> = {
  dev: "ai.opencode.desktop.dev",
  beta: "ai.opencode.desktop.beta",
  prod: "ai.opencode.desktop",
}
const appId = app.isPackaged ? APP_IDS[CHANNEL] : "ai.opencode.desktop.dev"
app.setName(app.isPackaged ? APP_NAMES[CHANNEL] : "OpenCode Dev")
app.setAppUserModelId(appId)
app.setPath("userData", join(app.getPath("appData"), appId))
const { autoUpdater } = pkg

import type { InitStep, ServerReadyData, SqliteMigrationProgress, WslConfig } from "../preload/types"
import { checkAppExists, resolveAppPath, wslPath } from "./apps"
import { CHANNEL, HAS_COMPLETED_SETUP_KEY, SETTINGS_STORE, UPDATER_ENABLED } from "./constants"
import { registerIpcHandlers, sendDeepLinks, sendMenuCommand, sendSqliteMigrationProgress } from "./ipc"
import { initLogging } from "./logging"
import { parseMarkdown } from "./markdown"
import { createMenu } from "./menu"
import { getDefaultServerUrl, getWslConfig, setDefaultServerUrl, setWslConfig, spawnLocalServer } from "./server"
import {
  createLoadingWindow,
  createMainWindow,
  registerRendererProtocol,
  setBackgroundColor,
  setDockIcon,
} from "./windows"
import { getStore } from "./store"
import { drizzle } from "drizzle-orm/node-sqlite/driver"
import type { Server } from "virtual:opencode-server"

const initEmitter = new EventEmitter()
let initStep: InitStep = { phase: "server_waiting" }

let mainWindow: BrowserWindow | null = null
let server: Server.Listener | null = null
const loadingComplete = defer<void>()

const pendingDeepLinks: string[] = []

const serverReady = defer<ServerReadyData>()
const logger = initLogging()

logger.log("app starting", {
  version: app.getVersion(),
  packaged: app.isPackaged,
})

let isFirstRun = false

function copyDirRecursive(src: string, dest: string, overwrite: boolean) {
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry)
    const destPath = join(dest, entry)
    if (statSync(srcPath).isDirectory()) {
      copyDirRecursive(srcPath, destPath, overwrite)
    } else {
      if (!overwrite && existsSync(destPath)) continue
      copyFileSync(srcPath, destPath)
    }
  }
}

function getConfigDir() {
  if (platform() === "win32") {
    return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "opencode")
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode")
}

function deployBundledConfigs() {
  const resourcePath = app.isPackaged
    ? join(process.resourcesPath, "opencode-defaults")
    : join(__dirname, "../../resources/opencode-defaults")

  if (!existsSync(resourcePath)) {
    logger.log("bundled configs not found, skipping deployment", { resourcePath })
    return
  }

  const targetPath = getConfigDir()
  logger.log("deploying bundled configs", { from: resourcePath, to: targetPath })
  copyDirRecursive(resourcePath, targetPath, false)
}

setupApp()

function setupApp() {
  ensureLoopbackNoProxy()
  app.commandLine.appendSwitch("proxy-bypass-list", "<-loopback>")

  if (!app.requestSingleInstanceLock()) {
    app.quit()
    return
  }

  app.on("second-instance", (_event: Event, argv: string[]) => {
    const urls = argv.filter((arg: string) => arg.startsWith("opencode://"))
    if (urls.length) {
      logger.log("deep link received via second-instance", { urls })
      emitDeepLinks(urls)
    }
    focusMainWindow()
  })

  app.on("open-url", (event: Event, url: string) => {
    event.preventDefault()
    logger.log("deep link received via open-url", { url })
    emitDeepLinks([url])
  })

  app.on("before-quit", () => {
    killSidecar()
  })

  app.on("will-quit", () => {
    killSidecar()
  })

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      killSidecar()
      app.exit(0)
    })
  }

  void app.whenReady().then(async () => {
    app.setAsDefaultProtocolClient("opencode")
    registerRendererProtocol()
    setDockIcon()
    setupAutoUpdater()
    await initialize()
  })
}

function emitDeepLinks(urls: string[]) {
  if (urls.length === 0) return
  pendingDeepLinks.push(...urls)
  if (mainWindow) sendDeepLinks(mainWindow, urls)
}

function focusMainWindow() {
  if (!mainWindow) return
  mainWindow.show()
  mainWindow.focus()
}

function setInitStep(step: InitStep) {
  initStep = step
  logger.log("init step", { step })
  initEmitter.emit("step", step)
}

async function initialize() {
  const needsMigration = !sqliteFileExists()
  const sqliteDone = needsMigration ? defer<void>() : undefined
  let overlay: BrowserWindow | null = null

  const port = await getSidecarPort()
  const hostname = "127.0.0.1"
  const url = `http://${hostname}:${port}`
  const password = randomUUID()

  const loadingTask = (async () => {
    logger.log("sidecar connection started", { url })

    initEmitter.on("sqlite", (progress: SqliteMigrationProgress) => {
      setInitStep({ phase: "sqlite_waiting" })
      if (overlay) sendSqliteMigrationProgress(overlay, progress)
      if (mainWindow) sendSqliteMigrationProgress(mainWindow, progress)
      if (progress.type === "Done") sqliteDone?.resolve()
    })

    if (needsMigration) {
      const { Database, JsonMigration } = await import("virtual:opencode-server")
      await JsonMigration.run(drizzle({ client: Database.Client().$client }), {
        progress: (event: { current: number; total: number }) => {
          const percent = Math.round(event.current / event.total) * 100
          initEmitter.emit("sqlite", { type: "InProgress", value: percent })
        },
      })
      initEmitter.emit("sqlite", { type: "Done" })

      sqliteDone?.resolve()
    }

    if (needsMigration) {
      await sqliteDone?.promise
    }

    logger.log("spawning sidecar", { url })
    const { listener, health } = await spawnLocalServer(hostname, port, password)
    server = listener
    serverReady.resolve({
      url,
      username: "opencode",
      password,
    })

    await Promise.race([
      health.wait,
      delay(30_000).then(() => {
        throw new Error("Sidecar health check timed out")
      }),
    ]).catch((error) => {
      logger.error("sidecar health check failed", error)
    })

    logger.log("loading task finished")
  })()

  if (needsMigration) {
    const show = await Promise.race([loadingTask.then(() => false), delay(1_000).then(() => true)])
    if (show) {
      overlay = createLoadingWindow()
      await delay(1_000)
    }
  }

  await loadingTask
  setInitStep({ phase: "done" })

  if (overlay) {
    await loadingComplete.promise
  }

  const store = getStore(SETTINGS_STORE)
  isFirstRun = !store.get(HAS_COMPLETED_SETUP_KEY)

  if (isFirstRun) {
    deployBundledConfigs()
    logger.log("first run detected, bundled configs deployed")
  }

  mainWindow = createMainWindow()
  wireMenu()

  overlay?.close()
}

function wireMenu() {
  if (!mainWindow) return
  createMenu({
    trigger: (id) => mainWindow && sendMenuCommand(mainWindow, id),
    checkForUpdates: () => {
      void checkForUpdates(true)
    },
    reload: () => mainWindow?.reload(),
    relaunch: () => {
      killSidecar()
      app.relaunch()
      app.exit(0)
    },
  })
}

registerIpcHandlers({
  killSidecar: () => killSidecar(),
  awaitInitialization: async (sendStep) => {
    sendStep(initStep)
    const listener = (step: InitStep) => sendStep(step)
    initEmitter.on("step", listener)
    try {
      logger.log("awaiting server ready")
      const res = await serverReady.promise
      logger.log("server ready", { url: res.url })
      return res
    } finally {
      initEmitter.off("step", listener)
    }
  },
  getWindowConfig: () => ({ updaterEnabled: UPDATER_ENABLED, isFirstRun }),
  consumeInitialDeepLinks: () => pendingDeepLinks.splice(0),
  getDefaultServerUrl: () => getDefaultServerUrl(),
  setDefaultServerUrl: (url) => setDefaultServerUrl(url),
  getWslConfig: () => Promise.resolve(getWslConfig()),
  setWslConfig: (config: WslConfig) => setWslConfig(config),
  getDisplayBackend: async () => null,
  setDisplayBackend: async () => undefined,
  parseMarkdown: async (markdown) => parseMarkdown(markdown),
  checkAppExists: async (appName) => checkAppExists(appName),
  wslPath: async (path, mode) => wslPath(path, mode),
  resolveAppPath: async (appName) => resolveAppPath(appName),
  loadingWindowComplete: () => loadingComplete.resolve(),
  runUpdater: async (alertOnFail) => checkForUpdates(alertOnFail),
  checkUpdate: async () => checkUpdate(),
  installUpdate: async () => installUpdate(),
  setBackgroundColor: (color) => setBackgroundColor(color),
  completeSetup: () => {
    const store = getStore(SETTINGS_STORE)
    store.set(HAS_COMPLETED_SETUP_KEY, true)
    isFirstRun = false
    logger.log("setup completed, marked in store")
  },
  setupAutoReports: async (enabled: boolean) => {
    logger.log("setupAutoReports", { enabled, platform: platform() })
    if (!enabled) return

    const opencodePath = (() => {
      const localBin = join(homedir(), ".opencode", "bin", "opencode")
      if (existsSync(localBin)) return localBin
      return "opencode"
    })()

    if (platform() === "darwin" || platform() === "linux") {
      try {
        const { stdout } = await execFileAsync("crontab", ["-l"]).catch(() => ({ stdout: "" }))
        const existing = stdout.split("\n").filter((line) => !line.includes("opencode run --command"))
        const crontab = [
          ...existing.filter((l) => l.trim()),
          `0 18 * * * cd ~ && ${opencodePath} run --command daily-report 2>/dev/null`,
          `0 18 * * 5 cd ~ && ${opencodePath} run --command weekly-report 2>/dev/null`,
        ].join("\n") + "\n"
        await execFileAsync("bash", ["-c", `echo "${crontab.replace(/"/g, '\\"')}" | crontab -`])
        logger.log("cron jobs installed for auto-reports")
      } catch (err) {
        logger.error("failed to install cron jobs", err)
      }
    } else if (platform() === "win32") {
      try {
        await execFileAsync("schtasks", [
          "/Create", "/F", "/SC", "DAILY", "/TN", "OpenCodeDailyReport",
          "/TR", `"${opencodePath}" run --command daily-report`,
          "/ST", "18:00",
        ])
        await execFileAsync("schtasks", [
          "/Create", "/F", "/SC", "WEEKLY", "/TN", "OpenCodeWeeklyReport",
          "/TR", `"${opencodePath}" run --command weekly-report`,
          "/ST", "18:00", "/D", "FRI",
        ])
        logger.log("Windows scheduled tasks created for auto-reports")
      } catch (err) {
        logger.error("failed to create Windows scheduled tasks", err)
      }
    }
  },
})

function killSidecar() {
  if (!server) return
  server.stop()
  server = null
}

function ensureLoopbackNoProxy() {
  const loopback = ["127.0.0.1", "localhost", "::1"]
  const upsert = (key: string) => {
    const items = (process.env[key] ?? "")
      .split(",")
      .map((value: string) => value.trim())
      .filter((value: string) => Boolean(value))

    for (const host of loopback) {
      if (items.some((value: string) => value.toLowerCase() === host)) continue
      items.push(host)
    }

    process.env[key] = items.join(",")
  }

  upsert("NO_PROXY")
  upsert("no_proxy")
}

async function getSidecarPort() {
  const fromEnv = process.env.OPENCODE_PORT
  if (fromEnv) {
    const parsed = Number.parseInt(fromEnv, 10)
    if (!Number.isNaN(parsed)) return parsed
  }

  return await new Promise<number>((resolve, reject) => {
    const server = createServer()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address !== "object" || !address) {
        server.close()
        reject(new Error("Failed to get port"))
        return
      }
      const port = address.port
      server.close(() => resolve(port))
    })
  })
}

function sqliteFileExists() {
  const xdg = process.env.XDG_DATA_HOME
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "share")
  return existsSync(join(base, "opencode", "opencode.db"))
}

function setupAutoUpdater() {
  if (!UPDATER_ENABLED) return
  autoUpdater.logger = logger
  autoUpdater.channel = "latest"
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = true
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  logger.log("auto updater configured", {
    channel: autoUpdater.channel,
    allowPrerelease: autoUpdater.allowPrerelease,
    allowDowngrade: autoUpdater.allowDowngrade,
    currentVersion: app.getVersion(),
  })
}

let updateReady = false

async function checkUpdate() {
  if (!UPDATER_ENABLED) return { updateAvailable: false }
  updateReady = false
  logger.log("checking for updates", {
    currentVersion: app.getVersion(),
    channel: autoUpdater.channel,
    allowPrerelease: autoUpdater.allowPrerelease,
    allowDowngrade: autoUpdater.allowDowngrade,
  })
  try {
    const result = await autoUpdater.checkForUpdates()
    const updateInfo = result?.updateInfo
    logger.log("update metadata fetched", {
      releaseVersion: updateInfo?.version ?? null,
      releaseDate: updateInfo?.releaseDate ?? null,
      releaseName: updateInfo?.releaseName ?? null,
      files: updateInfo?.files?.map((file) => file.url) ?? [],
    })
    const version = result?.updateInfo?.version
    if (result?.isUpdateAvailable === false || !version) {
      logger.log("no update available", {
        reason: "provider returned no newer version",
      })
      return { updateAvailable: false }
    }
    logger.log("update available", { version })
    await autoUpdater.downloadUpdate()
    logger.log("update download completed", { version })
    updateReady = true
    return { updateAvailable: true, version }
  } catch (error) {
    logger.error("update check failed", error)
    return { updateAvailable: false, failed: true }
  }
}

async function installUpdate() {
  if (!updateReady) return
  killSidecar()
  autoUpdater.quitAndInstall()
}

async function checkForUpdates(alertOnFail: boolean) {
  if (!UPDATER_ENABLED) return
  logger.log("checkForUpdates invoked", { alertOnFail })
  const result = await checkUpdate()
  if (!result.updateAvailable) {
    if (result.failed) {
      logger.log("no update decision", { reason: "update check failed" })
      if (!alertOnFail) return
      await dialog.showMessageBox({
        type: "error",
        message: "Update check failed.",
        title: "Update Error",
      })
      return
    }

    logger.log("no update decision", { reason: "already up to date" })
    if (!alertOnFail) return
    await dialog.showMessageBox({
      type: "info",
      message: "You're up to date.",
      title: "No Updates",
    })
    return
  }

  const response = await dialog.showMessageBox({
    type: "info",
    message: `Update ${result.version ?? ""} downloaded. Restart now?`,
    title: "Update Ready",
    buttons: ["Restart", "Later"],
    defaultId: 0,
    cancelId: 1,
  })
  logger.log("update prompt response", {
    version: result.version ?? null,
    restartNow: response.response === 0,
  })
  if (response.response === 0) {
    await installUpdate()
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function defer<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
