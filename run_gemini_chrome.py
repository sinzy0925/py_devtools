#!/usr/bin/env python3
"""Start Chrome with CDP (same profile as start-chrome-cdp.ps1), then run Gemini CLI
with chrome-devtools MCP against that browser.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent
DEFAULT_MODEL = "gemini-3.5-flash-lite"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = "9222"
DEFAULT_PROFILE = "./chrome-profile"


def load_env_file(path: Path, *, override: bool = False) -> None:
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and (override or key not in os.environ):
            os.environ[key] = value


def resolve_profile(profile_rel: str) -> Path:
    p = Path(profile_rel)
    if p.is_absolute():
        return p
    return (REPO_ROOT / str(p).lstrip("./\\")).resolve()


def find_chrome() -> Path:
    candidates = [
        Path(os.environ.get("ProgramFiles", r"C:\Program Files"))
        / "Google/Chrome/Application/chrome.exe",
        Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"))
        / "Google/Chrome/Application/chrome.exe",
        Path(os.environ.get("LOCALAPPDATA", ""))
        / "Google/Chrome/Application/chrome.exe",
    ]
    for path in candidates:
        if path.is_file():
            return path
    raise FileNotFoundError("Chrome not found")


def cdp_ready(host: str, port: str, timeout: float = 1.0) -> bool:
    url = f"http://{host}:{port}/json/version"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return 200 <= resp.status < 300
    except (urllib.error.URLError, TimeoutError, OSError):
        return False


def ensure_chrome(host: str, port: str, profile: Path) -> None:
    if cdp_ready(host, port):
        print(f"CDP already listening at http://{host}:{port}", flush=True)
        return

    chrome = find_chrome()
    profile.mkdir(parents=True, exist_ok=True)
    args = [
        str(chrome),
        f"--remote-debugging-address={host}",
        f"--remote-debugging-port={port}",
        f"--user-data-dir={profile}",
        "--no-first-run",
        "--no-default-browser-check",
    ]
    subprocess.Popen(args, cwd=str(REPO_ROOT))
    print(f"Chrome started: CDP http://{host}:{port}", flush=True)
    print(f"Profile: {profile}", flush=True)


def wait_for_cdp(host: str, port: str, timeout_sec: float = 30.0) -> None:
    deadline = time.time() + timeout_sec
    while time.time() < deadline:
        if cdp_ready(host, port):
            return
        time.sleep(0.4)
    raise TimeoutError(f"CDP did not become ready at http://{host}:{port}")


def find_gemini_cmd() -> list[str]:
    gemini = shutil.which("gemini")
    if gemini:
        return [gemini]
    npx = shutil.which("npx")
    if npx:
        return [npx, "-y", "@google/gemini-cli"]
    raise FileNotFoundError(
        "gemini CLI not found. Install with: npm install -g @google/gemini-cli"
    )


def resolve_path(path_str: str) -> Path:
    p = Path(path_str).expanduser()
    if not p.is_absolute():
        p = (REPO_ROOT / p).resolve()
    return p


def run_gemini(
    model: str,
    prompt: str,
    browser_url: str,
    *,
    system_prompt_file: Path | None = None,
) -> int:
    # Ensure project MCP settings (.gemini/settings.json) are used.
    # Standing instructions: .gemini/GEMINI.md is loaded automatically by Gemini CLI.
    cmd = [
        *find_gemini_cmd(),
        "-m",
        model,
        "--yolo",
        "--allowed-mcp-server-names",
        "chrome-devtools",
        "-p",
        prompt,
        "--output-format",
        "text",
    ]
    env = os.environ.copy()
    env.setdefault("CHROME_DEVTOOLS_MCP_BROWSER_URL", browser_url)

    if system_prompt_file is not None:
        if not system_prompt_file.is_file():
            raise FileNotFoundError(f"system prompt file not found: {system_prompt_file}")
        # Full replacement of Gemini CLI's built-in system prompt.
        env["GEMINI_SYSTEM_MD"] = str(system_prompt_file)

    gemini_md = REPO_ROOT / ".gemini" / "GEMINI.md"
    print(f"Model: {model}", flush=True)
    print(f"Browser: {browser_url}", flush=True)
    if gemini_md.is_file():
        print(f"Context: {gemini_md} (auto-loaded GEMINI.md)", flush=True)
    if system_prompt_file is not None:
        print(f"System prompt override: {system_prompt_file}", flush=True)
    print("Running Gemini with chrome-devtools MCP...", flush=True)
    print("---", flush=True)
    completed = subprocess.run(cmd, cwd=str(REPO_ROOT), env=env)
    return int(completed.returncode)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Start Chrome with CDP (chrome-profile), then run Gemini CLI "
            "so it can drive the browser via chrome-devtools MCP."
        )
    )
    parser.add_argument(
        "--model",
        default=DEFAULT_MODEL,
        help=f"Gemini model id (default: {DEFAULT_MODEL})",
    )
    parser.add_argument(
        "--prompt",
        required=True,
        help="Natural-language instruction for Gemini (user prompt)",
    )
    parser.add_argument(
        "--system-prompt-file",
        default=None,
        help=(
            "Markdown file that fully replaces Gemini CLI's built-in system prompt "
            "(sets GEMINI_SYSTEM_MD). Prefer editing .gemini/GEMINI.md for additive "
            "standing instructions."
        ),
    )
    parser.add_argument(
        "--cdp-host",
        default=None,
        help="CDP host (default: CDP_HOST or 127.0.0.1)",
    )
    parser.add_argument(
        "--cdp-port",
        default=None,
        help="CDP port (default: CDP_PORT or 9222)",
    )
    parser.add_argument(
        "--skip-chrome",
        action="store_true",
        help="Do not start Chrome; only run Gemini against existing CDP",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    # Source of truth: this repository's .env (CDP + GEMINI_API_KEY).
    env_path = REPO_ROOT / ".env"
    load_env_file(env_path, override=True)

    args = parse_args(argv)
    host = args.cdp_host or os.environ.get("CDP_HOST", DEFAULT_HOST)
    port = str(args.cdp_port or os.environ.get("CDP_PORT", DEFAULT_PORT))
    profile_rel = os.environ.get("CHROME_USER_DATA_DIR", DEFAULT_PROFILE)
    profile = resolve_profile(profile_rel)
    browser_url = f"http://{host}:{port}"

    if not os.environ.get("GEMINI_API_KEY"):
        print(
            f"GEMINI_API_KEY is not set. Add it to {env_path}",
            file=sys.stderr,
        )
        return 2

    # Keep MCP browser URL aligned with this run.
    settings = REPO_ROOT / ".gemini" / "settings.json"
    if not settings.is_file():
        print(f"Missing MCP settings: {settings}", file=sys.stderr)
        return 2

    if not args.skip_chrome:
        ensure_chrome(host, port, profile)
        wait_for_cdp(host, port)

    system_prompt_file = None
    system_path = args.system_prompt_file or os.environ.get("SYSTEM_PROMPT_FILE")
    if system_path:
        system_prompt_file = resolve_path(system_path)

    return run_gemini(
        args.model,
        args.prompt,
        browser_url,
        system_prompt_file=system_prompt_file,
    )


if __name__ == "__main__":
    raise SystemExit(main())
