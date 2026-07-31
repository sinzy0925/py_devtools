import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cdpReady,
  ensureChrome,
  resolveProfile,
  resolveRepoPath,
  writeChromeDownloadPrefs,
} from "./run-gemini-chrome.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadEnvFile(filePath: string): void {
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
    if (key) process.env[key] = value;
  }
}

async function main(): Promise<void> {
  loadEnvFile(path.join(REPO_ROOT, ".env"));
  const host = process.env.CDP_HOST || "127.0.0.1";
  const port = process.env.CDP_PORT || "9222";
  const profile = resolveProfile(process.env.CHROME_USER_DATA_DIR || "./chrome-profile");
  const downloadDir = resolveRepoPath(process.env.DOWNLOAD_DIR || "./downloads");

  if (await cdpReady(host, port)) {
    console.log(`CDP already listening at http://${host}:${port}`);
    return;
  }

  writeChromeDownloadPrefs(profile, downloadDir);
  await ensureChrome(host, port, profile);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
