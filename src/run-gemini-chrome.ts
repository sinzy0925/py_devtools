import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import {
  CdpError,
  configureChromeDownloads,
  downloadTextViaChrome,
} from "./cdp.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = "9222";
const DEFAULT_PROFILE = "./chrome-profile";
const DEFAULT_DOWNLOAD_DIR = "./downloads";

const STANDING_PROMPT_PREFIX =
  "[必須ルール] " +
  "既に開いているChromeを使う（新規起動禁止）。" +
  "検索は必ずDuckDuckGo（https://duckduckgo.com/?q=...）のみ。Google検索は禁止。";

export type CliArgs = {
  model?: string;
  prompt: string;
  systemPromptFile?: string;
  cdpHost?: string;
  cdpPort?: string;
  skipChrome: boolean;
  noDownload: boolean;
};

function loadEnvFile(filePath: string, override = false): void {
  if (!existsSync(filePath)) return;
  const text = readFileSync(filePath, "utf8");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const eq = line.indexOf("=");
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!key) continue;
    if (override || process.env[key] == null) {
      process.env[key] = value;
    }
  }
}

export function resolveRepoPath(pathStr: string): string {
  const expanded = pathStr.replace(/^~(?=$|[\\/])/, homedir());
  if (path.isAbsolute(expanded)) return path.resolve(expanded);
  return path.resolve(REPO_ROOT, expanded.replace(/^\.[\\/]/, ""));
}

export function resolveProfile(profileRel: string): string {
  return resolveRepoPath(profileRel);
}

function findChrome(): string {
  const candidates = [
    path.join(process.env.ProgramFiles ?? "C:\\Program Files", "Google/Chrome/Application/chrome.exe"),
    path.join(
      process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)",
      "Google/Chrome/Application/chrome.exe",
    ),
    path.join(process.env.LOCALAPPDATA ?? "", "Google/Chrome/Application/chrome.exe"),
  ];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  throw new Error("Chrome not found");
}

export async function cdpReady(host: string, port: string, timeoutMs = 1000): Promise<boolean> {
  const url = `http://${host}:${port}/json/version`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function ensureChrome(host: string, port: string, profile: string): Promise<void> {
  if (await cdpReady(host, port)) {
    console.log(`CDP already listening at http://${host}:${port}`);
    return;
  }
  const chrome = findChrome();
  mkdirSync(profile, { recursive: true });
  const child = spawn(
    chrome,
    [
      `--remote-debugging-address=${host}`,
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
    {
      cwd: REPO_ROOT,
      detached: true,
      stdio: "ignore",
    },
  );
  child.unref();
  console.log(`Chrome started: CDP http://${host}:${port}`);
  console.log(`Profile: ${profile}`);
}

export async function waitForCdp(host: string, port: string, timeoutSec = 30): Promise<void> {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    if (await cdpReady(host, port)) return;
    await sleep(400);
  }
  throw new Error(`CDP did not become ready at http://${host}:${port}`);
}

function whichSync(cmd: string): string | undefined {
  const pathEnv = process.env.PATH ?? "";
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)
      : [""];
  for (const dir of pathEnv.split(path.delimiter)) {
    for (const ext of exts) {
      const candidate = path.join(dir, cmd + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function findGeminiCmd(): string[] {
  const gemini = whichSync("gemini");
  if (gemini) {
    const geminiPath = path.resolve(gemini);
    const bases = [path.dirname(geminiPath), path.dirname(path.dirname(geminiPath))];
    for (const base of bases) {
      const js = path.join(base, "node_modules", "@google", "gemini-cli", "bundle", "gemini.js");
      if (existsSync(js)) {
        const node = whichSync("node");
        if (!node) throw new Error("node not found (required to run Gemini CLI)");
        return [node, js];
      }
    }
    return [geminiPath];
  }
  const npx = whichSync("npx");
  if (npx) return [npx, "-y", "@google/gemini-cli"];
  throw new Error("gemini CLI not found. Install with: npm install -g @google/gemini-cli");
}

function prepareGeminiEnv(browserUrl: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (!env.CHROME_DEVTOOLS_MCP_BROWSER_URL) {
    env.CHROME_DEVTOOLS_MCP_BROWSER_URL = browserUrl;
  }
  if (env.GOOGLE_API_KEY) {
    delete env.GEMINI_API_KEY;
  }
  return env;
}

function buildPrompt(userPrompt: string): string {
  return `${STANDING_PROMPT_PREFIX} ユーザー依頼: ${userPrompt.trim()}`;
}

export function writeChromeDownloadPrefs(profile: string, downloadDir: string): void {
  const defaultDir = path.join(profile, "Default");
  mkdirSync(defaultDir, { recursive: true });
  mkdirSync(downloadDir, { recursive: true });
  const prefsPath = path.join(defaultDir, "Preferences");
  let data: Record<string, unknown> = {};
  if (existsSync(prefsPath)) {
    try {
      data = JSON.parse(readFileSync(prefsPath, "utf8")) as Record<string, unknown>;
    } catch {
      data = {};
    }
  }
  const absDir = path.resolve(downloadDir);
  const download = (data.download as Record<string, unknown> | undefined) ?? {};
  download.default_directory = absDir;
  download.prompt_for_download = false;
  data.download = download;
  const savefile = (data.savefile as Record<string, unknown> | undefined) ?? {};
  savefile.default_directory = absDir;
  data.savefile = savefile;
  writeFileSync(prefsPath, JSON.stringify(data), "utf8");
}

function extractFinalAnswer(rawOutput: string): string {
  const text = rawOutput.trim();
  if (!text) return text;
  const noise =
    /^(YOLO mode is enabled\.|Ripgrep is not available\.|Both GOOGLE_API_KEY|Attempt \d+ failed|Ready\. How can I assist|_ApiError:|at throwErrorIfNotOK|at process\.|at async |Running Gemini with chrome-devtools MCP\.\.\.).*$/i;
  const lines = text.split(/\r?\n/).filter((ln) => !noise.test(ln.trim()));
  return lines.join("\n").trim() || text;
}

async function waitForDownloadedFile(
  filename: string,
  downloadDir: string,
  timeoutSec = 8,
): Promise<string | null> {
  const candidates = [downloadDir, path.join(homedir(), "Downloads")];
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    for (const dir of candidates) {
      const filePath = path.join(dir, filename);
      try {
        if (existsSync(filePath) && statSync(filePath).size > 0) {
          return filePath;
        }
      } catch {
        // ignore
      }
    }
    await sleep(250);
  }
  return null;
}

function ensureCopyInDownloadDir(found: string, downloadDir: string, filename: string): string {
  mkdirSync(downloadDir, { recursive: true });
  const dest = path.join(downloadDir, filename);
  if (path.resolve(found) !== path.resolve(dest)) {
    copyFileSync(found, dest);
  }
  return dest;
}

async function runGemini(
  model: string,
  prompt: string,
  browserUrl: string,
  systemPromptFile?: string,
): Promise<{ code: number; output: string }> {
  const effectivePrompt = buildPrompt(prompt);
  const cmd = [
    ...findGeminiCmd(),
    "-m",
    model,
    "--yolo",
    "--allowed-mcp-server-names",
    "chrome-devtools",
    "-p",
    effectivePrompt,
    "--output-format",
    "text",
  ];
  const env = prepareGeminiEnv(browserUrl);
  if (systemPromptFile) {
    if (!existsSync(systemPromptFile)) {
      throw new Error(`system prompt file not found: ${systemPromptFile}`);
    }
    env.GEMINI_SYSTEM_MD = systemPromptFile;
  }

  const geminiMd = path.join(REPO_ROOT, ".gemini", "GEMINI.md");
  console.log(`Model: ${model}`);
  console.log(`Browser: ${browserUrl}`);
  if (existsSync(geminiMd)) {
    console.log(`Context: ${geminiMd} (auto-loaded GEMINI.md)`);
  }
  if (systemPromptFile) {
    console.log(`System prompt override: ${systemPromptFile}`);
  }
  console.log("Running Gemini with chrome-devtools MCP...");
  console.log("---");

  const [exe, ...args] = cmd;
  const proc = spawn(exe, args, {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let output = "";
  const onChunk = (buf: Buffer) => {
    const chunk = buf.toString("utf8");
    output += chunk;
    process.stdout.write(chunk);
  };
  proc.stdout?.on("data", onChunk);
  proc.stderr?.on("data", onChunk);

  const code: number = await new Promise((resolve, reject) => {
    proc.on("error", reject);
    proc.on("close", (exitCode) => resolve(exitCode ?? 1));
  });
  return { code, output };
}

function printHelp(): void {
  console.log(`Usage: run-gemini-chrome --prompt <text> [options]

Options:
  --prompt <text>              Natural-language instruction (required)
  --model <id>                 Gemini model (default: GEMINI_MODEL or ${DEFAULT_MODEL})
  --system-prompt-file <path>  Replace Gemini CLI system prompt
  --cdp-host <host>            CDP host
  --cdp-port <port>            CDP port
  --skip-chrome                Do not start Chrome
  --no-download                Do not save output via Chrome download
  -h, --help                   Show help`);
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    prompt: "",
    skipChrome: false,
    noDownload: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v == null) throw new Error(`Missing value for ${a}`);
      return v;
    };
    switch (a) {
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
        break;
      case "--model":
        args.model = next();
        break;
      case "--prompt":
        args.prompt = next();
        break;
      case "--system-prompt-file":
        args.systemPromptFile = next();
        break;
      case "--cdp-host":
        args.cdpHost = next();
        break;
      case "--cdp-port":
        args.cdpPort = next();
        break;
      case "--skip-chrome":
        args.skipChrome = true;
        break;
      case "--no-download":
        args.noDownload = true;
        break;
      default:
        throw new Error(`Unknown argument: ${a}`);
    }
  }

  if (!args.prompt.trim()) {
    throw new Error("--prompt is required");
  }
  return args;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const envPath = path.join(REPO_ROOT, ".env");
  loadEnvFile(envPath, true);

  const args = parseArgs(argv);
  const model = args.model || process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const host = args.cdpHost || process.env.CDP_HOST || DEFAULT_HOST;
  const port = String(args.cdpPort || process.env.CDP_PORT || DEFAULT_PORT);
  const profile = resolveProfile(process.env.CHROME_USER_DATA_DIR || DEFAULT_PROFILE);
  const browserUrl = `http://${host}:${port}`;
  const downloadDir = resolveRepoPath(process.env.DOWNLOAD_DIR || DEFAULT_DOWNLOAD_DIR);

  if (!process.env.GOOGLE_API_KEY) {
    console.error(`GOOGLE_API_KEY is not set. Add it to ${envPath}`);
    return 2;
  }

  const settings = path.join(REPO_ROOT, ".gemini", "settings.json");
  if (!existsSync(settings)) {
    console.error(`Missing MCP settings: ${settings}`);
    return 2;
  }

  if (!args.skipChrome) {
    if (!(await cdpReady(host, port))) {
      writeChromeDownloadPrefs(profile, downloadDir);
    }
    await ensureChrome(host, port, profile);
    await waitForCdp(host, port);
  }

  if (!args.noDownload) {
    try {
      mkdirSync(downloadDir, { recursive: true });
      await configureChromeDownloads(host, port, path.resolve(downloadDir));
      console.log(`Download dir: ${downloadDir}`);
    } catch (err) {
      console.log(`Warning: could not configure Chrome downloads: ${String(err)}`);
    }
  }

  const systemPath = args.systemPromptFile || process.env.SYSTEM_PROMPT_FILE;
  const systemPromptFile = systemPath ? resolveRepoPath(systemPath) : undefined;

  const { code, output } = await runGemini(model, args.prompt, browserUrl, systemPromptFile);

  if (!args.noDownload) {
    const answer = extractFinalAnswer(output);
    if (answer.trim()) {
      const stamp = new Date();
      const pad = (n: number) => String(n).padStart(2, "0");
      const filename =
        `gemini-output-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}` +
        `-${pad(stamp.getHours())}${pad(stamp.getMinutes())}${pad(stamp.getSeconds())}.md`;
      try {
        await downloadTextViaChrome(host, port, answer, filename);
        const found = await waitForDownloadedFile(filename, downloadDir);
        if (!found) throw new CdpError("download file not found after trigger");
        const dest = ensureCopyInDownloadDir(found, downloadDir, filename);
        console.log("---");
        console.log(`Chrome download: ${found}`);
        if (path.resolve(dest) !== path.resolve(found)) {
          console.log(`Copied to: ${dest}`);
        }
      } catch (err) {
        mkdirSync(downloadDir, { recursive: true });
        const dest = path.join(downloadDir, filename);
        writeFileSync(dest, answer, "utf8");
        console.log("---");
        console.log(`Chrome download failed (${String(err)}); wrote file directly: ${dest}`);
      }
    } else {
      console.log("No output text to download.");
    }
  }

  return code;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isDirectRun()) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
