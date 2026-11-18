#!/usr/bin/env python3
"""Read Cursor plan usage by driving the Cursor CLI's own /usage command in a pseudo-terminal.

The CLI has no non-interactive usage command. This starts `agent` in a pty, types /usage,
reads the screen and quits, so it never touches the CLI's stored login. A Windows build
(agent.cmd, reached from WSL) runs through cmd.exe; ConPTY then asks for the cursor position
before it prints anything, so that query is answered.

usage: cursor-usage.py [--json] [path to agent or agent.cmd]
  --json   print {"included": %, "auto": %, "api": %, "on_demand": "$..", "resets": "..", "plan": ".."}
"""
import fcntl
import json
import os
import pty
import re
import select
import shutil
import struct
import sys
import termios
import time

args = sys.argv[1:]
as_json = "--json" in args
args = [a for a in args if a != "--json"]
gitconfig = None  # --gitconfig FILE: GIT_CONFIG_GLOBAL for the agent (its plugin installs use git)
if "--gitconfig" in args:
    i = args.index("--gitconfig")
    gitconfig = args[i + 1] if i + 1 < len(args) else None
    del args[i:i + 2]
agent = args[0] if args else (shutil.which("agent") or shutil.which("cursor-agent") or os.path.expanduser("~/.local/bin/agent"))
argv = ["cmd.exe", "/c", agent, "--trust"] if agent.lower().endswith(".cmd") else [agent, "--trust"]
ANSI = re.compile(rb"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>78]")

pid, fd = pty.fork()
if pid == 0:
    home = os.path.expanduser("~")
    if argv[0] == "cmd.exe":  # start in the Windows profile, not in a WSL path cmd.exe cannot use
        import subprocess
        try:
            win = subprocess.run(["cmd.exe", "/c", "echo %USERPROFILE%"], capture_output=True, text=True, timeout=10, cwd="/mnt/c").stdout.strip()
            home = subprocess.run(["wslpath", "-u", win], capture_output=True, text=True, timeout=10).stdout.strip() or "/mnt/c"
        except Exception:
            home = "/mnt/c"
    os.chdir(home if os.path.isdir(home) else "/")
    # Started from a service or a non-interactive ssh there is no TERM, and the TUI draws nothing.
    if os.environ.get("TERM", "dumb") == "dumb":
        os.environ["TERM"] = "xterm-256color"
    if gitconfig:
        os.environ["GIT_CONFIG_GLOBAL"] = gitconfig
        if argv[0] == "cmd.exe":  # a Windows path, handed across WSL interop as is
            os.environ["WSLENV"] = ":".join(filter(None, [os.environ.get("WSLENV"), "GIT_CONFIG_GLOBAL"]))
    os.execvp(argv[0], argv)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 140, 0, 0))

out = b""


def pump(seconds, until=None):
    global out
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.2)
        if r:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                return
            out += chunk
            # Windows ConPTY asks where the cursor is (DSR) and waits for the answer.
            for _ in range(chunk.count(b"\x1b[6n")):
                os.write(fd, b"\x1b[1;1R")
            if until and until.search(ANSI.sub(b"", out)):
                return


pump(30, re.compile(rb"Add a follow-up|Plan, search|ctrl\+c", re.I))
mark = len(out)
for ch in "/usage":
    os.write(fd, ch.encode())
    time.sleep(0.08)
pump(2)
os.write(fd, b"\r")
pump(30, re.compile(rb"Esc to close", re.I))
pump(1)
screen = ANSI.sub(b"", out[mark:]).decode("utf-8", "replace")
for _ in range(3):
    os.write(fd, b"\x03")
    pump(1)
try:
    os.kill(pid, 9)
except OSError:
    pass

if os.environ.get("CURSOR_USAGE_DEBUG"):
    whole = ANSI.sub(b"", out).decode("utf-8", "replace")
    print("\n".join(l for l in re.split(r"[\r\n]+", whole) if l.strip())[-4000:], file=sys.stderr)

if not as_json:
    seen, keep = set(), []
    for line in (l.rstrip() for l in re.split(r"[\r\n]+", screen)):
        if line.strip() and line not in seen:  # the TUI redraws; keep each line once
            seen.add(line)
            keep.append(line)
    print("\n".join(keep[-40:]))
    sys.exit(0)


def pct(label):
    m = re.findall(label + r"\s*([0-9]+(?:\.[0-9]+)?)\s*%\s*used", screen)
    return float(m[-1]) if m else None


usage = {
    "plan": (re.findall(r"Usage\s*•\s*([A-Za-z+]+?)(?=Resets|\s|$)", screen) or [None])[-1],
    "resets": (re.findall(r"Resets\s*([A-Za-z]{3,9}\.?\s\d{1,2}(?:,\s\d{4})?|[^\s│|]+)", screen) or [None])[-1],
    "included": pct(r"Included"),
    "auto": pct(r"\bAuto"),
    "api": pct(r"\bAPI"),
    "on_demand": (re.findall(r"On-Demand\s*(\$[0-9][0-9.,]*)", screen) or [None])[-1],
    "on_demand_limit": None if "No monthly limit" not in screen else "none",
}
if usage["included"] is None and usage["auto"] is None:
    usage["error"] = "no usage figures on the /usage screen: " + " ".join(screen.split())[-300:]
print(json.dumps(usage, ensure_ascii=False))
