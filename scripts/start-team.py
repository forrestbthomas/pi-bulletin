#!/usr/bin/env python3
"""start-team.py — launch a pi-bulletin agent team.

Standalone launcher (decoupled from the pi-harness eval): starts N Pi
sessions in tmux panes sharing one bulletin root, gives each a role, and
captures sessions + bulletin state after you detach. Works for any project.

Usage:
    ./start-team.py --team <name> [--target <path>] [--roles a,b,c]
                    [--task-file <path>] [--launch "<pi-run chat ...>"]
                    [--root <dir>] [--capture-dir <dir>] [--dryrun]

Defaults: 5 roles (lead-synthesizer + 4 analysts), the read-only parallel
review task, launch = `pi-run chat` (add --provider/--model via --launch),
capture into <cwd>/bulletin-runs/<team>-<ts>.

Env: tmux + pi-run on PATH; BW_SESSION set when pi-run needs secret-manager
key resolution. Python 3 stdlib only.
"""

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROLES = ["lead-synthesizer", "bug-hunter", "complexity-analyst",
         "security-spotter", "devil-advocate"]

ROLE_PROMPT = {
    "lead-synthesizer": ("You are the lead. Coordinate, resolve conflicts, do NOT duplicate "
                         "others' investigation. Write the final report."),
    "bug-hunter": "You are the bug-hunter lens. Find real correctness bugs with code evidence.",
    "complexity-analyst": "You are the complexity lens. Find over-complex / hard-to-maintain code paths.",
    "security-spotter": "You are the security lens. Find security-relevant issues with code evidence.",
    "devil-advocate": "You are the devil's advocate. Stress-test others' findings; rank by real impact.",
}

DEFAULT_TASK = """Perform a read-only parallel review of this codebase. Do NOT modify any files.
Five agents each take one lens:

1. lead-synthesizer: do not investigate deeply yourself — collect the other
   agents' findings, resolve conflicts, and produce one prioritized findings
   report (top issues first, each with file/line evidence and a suggested fix).
2. bug-hunter: find real correctness bugs (not style nits). Evidence = code.
3. complexity-analyst: find over-complex or hard-to-maintain code paths.
4. security-spotter: find security-relevant issues (secrets, injection,
   unsafe defaults, missing validation). Evidence = code.
5. devil-advocate: for each major finding from others, play devil's advocate —
   is it actually a problem? Rank findings by real impact.

Synthesize into: a prioritized findings report (top 10 max, each with
file:line evidence, impact, suggested fix) plus a one-paragraph summary of
coordination quality."""

TRIVIAL_TASK = ("Read-only: look at the README of this repo and report one thing "
                "you notice. Do NOT modify any files.")

DEFAULT_LAUNCH = "pi-run chat"


# --- tmux helpers (same proven patterns as the eval driver) ------------------
def tmux(args, capture=False, timeout=60):
    cmd = ["tmux"] + args
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0 and not capture:
        raise RuntimeError(f"tmux {' '.join(args)} failed: {r.stderr.strip()}")
    return r

def pane_exists(session):
    return tmux(["has-session", "-t", session], capture=True).returncode == 0

def probe_pane(pane, exit_marker, ready_markers, timeout_s=90):
    waited = 0
    last = ""
    while waited < timeout_s:
        out = tmux(["capture-pane", "-p", "-t", pane], capture=True).stdout or ""
        if exit_marker in out:
            return "dead", out
        if any(m in out for m in ready_markers):
            return "ready", out
        if out:
            last = out
        time.sleep(2)
        waited += 2
    return "timeout", last

def type_lines(pane, text):
    for line in text.splitlines() or [""]:
        tmux(["send-keys", "-t", pane, line if line else " ", "Enter"])

def show_pane_tail(out, n=30):
    lines = [l for l in (out or "").splitlines() if l.strip()]
    print("\n".join(lines[-n:]))

def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)

def die(msg):
    print(f"ERROR: {msg}", file=sys.stderr, flush=True)
    sys.exit(1)


def main():
    ap = argparse.ArgumentParser(description="launch a pi-bulletin agent team")
    ap.add_argument("--team", required=True, help="team name (bulletin dir + tmux session)")
    ap.add_argument("--target", default=None, help="review target path (default: cwd)")
    ap.add_argument("--roles", default=",".join(ROLES), help="comma-separated role names")
    ap.add_argument("--task-file", default=None, help="task prompt file (default: read-only review)")
    ap.add_argument("--launch", default=DEFAULT_LAUNCH, help="agent launch command (default: pi-run chat)")
    ap.add_argument("--root", default=None, help="working dir for the panes (default: cwd)")
    ap.add_argument("--capture-dir", default=None, help="where to capture sessions/bulletin (default: <cwd>/bulletin-runs)")
    ap.add_argument("--dryrun", action="store_true", help="2 roles + trivial task (smoke)")
    args = ap.parse_args()

    session = args.team
    root = Path(args.root or os.getcwd()).resolve()
    target = Path(args.target or root).resolve()
    roles = [r.strip() for r in args.roles.split(",") if r.strip()]
    if args.dryrun:
        roles = roles[:2]
    task = (Path(args.task_file).read_text() if args.task_file
            else (TRIVIAL_TASK if args.dryrun else DEFAULT_TASK))
    capture_dir = Path(args.capture_dir or root / "bulletin-runs") / f"{session}-{time.strftime('%Y%m%d-%H%M%S')}"

    # env checks
    if not shutil.which("tmux"):
        die("tmux not on PATH")
    if not shutil.which("pi-run") and not args.launch.startswith("pi"):
        die(f"launch command not found: {args.launch}")
    if not target.is_dir():
        die(f"target {target} missing")
    if pane_exists(session):
        die(f"tmux session '{session}' already exists — pick a fresh team or clean up")
    # Live bulletin state lives under the project's .pi (like sessions), NOT
    # inside the capture dir — capture copies it out, so source != dest.
    bulletin_root = root / ".pi" / "bulletin" / session
    capture_dir.mkdir(parents=True, exist_ok=True)
    bulletin_root.mkdir(parents=True, exist_ok=True)

    env0 = (f"env PI_BULLETIN_AGENT={roles[0]} PI_BULLETIN_ROOT={bulletin_root} "
            f"{args.launch}; echo PANE_EXITED=$?; sleep 600")
    session_env = []
    if os.environ.get("BW_SESSION"):
        session_env = ["-e", f"BW_SESSION={os.environ['BW_SESSION']}"]
    tmux(["new-session", "-d", "-x", "240", "-y", "60", *session_env,
          "-s", session, "-c", str(root), env0])
    for i in range(1, len(roles)):
        env_i = (f"env PI_BULLETIN_AGENT={roles[i]} PI_BULLETIN_ROOT={bulletin_root} "
                 f"{args.launch}; echo PANE_EXITED=$?; sleep 600")
        try:
            tmux(["split-window", "-t", session, "-c", str(root), env_i])
        except RuntimeError as e:
            tmux(["kill-session", "-t", session], capture=True)
            die(f"could not create {len(roles)} panes: {e} (resize terminal and retry)")
    tmux(["select-layout", "-t", session, "tiled"])

    # send each role its instruction + task
    ready_markers = ("❯", ">", "gpt-5.6-terra", "openrouter")
    for i, role in enumerate(roles):
        pane = f"{session}.{i}"
        status, out = probe_pane(pane, "PANE_EXITED", ready_markers)
        if status == "dead":
            show_pane_tail(out)
            die(f"pane {pane} exited during startup — see output above")
        if status == "timeout":
            log(f"WARN: pane {pane} prompt not detected; sending anyway")
        rp = ROLE_PROMPT.get(role, f"You are the {role} lens. Find evidence-backed findings.")
        if i == 0:
            type_lines(pane, (
                f"You are {role}. {rp} Use the bulletin tools (bulletin_status, "
                "bulletin_post, bulletin_read, bulletin_conflicts, bulletin_sync) for ALL team "
                "coordination — never direct-message other agents. IMPORTANT: teammates NEVER "
                "message you directly — collect their findings with bulletin_read and never wait "
                "for them to 'send' you anything. Team name: "
                f"{session}. Review the target at {target} (read-only). As lead, run "
                "bulletin_conflicts then bulletin_sync at each round end.\n" + task
            ))
        else:
            type_lines(pane, (
                f"You are {role}. {rp} Use the bulletin tools for ALL team coordination. "
                f"Team name: {session}. Review the target at {target} (read-only). Post "
                "findings with bulletin_post(kind=finding, ref=topic, claim=one-liner).\n" + task
            ))
    log(f"{len(roles)} panes launched. Attaching — watch the team; detach with Ctrl-b d when done.")
    tmux(["attach", "-t", session], timeout=None)

    # capture after detach
    r = tmux(["capture-pane", "-p", "-t", session, "-S", "-2000"], capture=True)
    (capture_dir / "pane-transcript.txt").write_text(r.stdout or "")
    ss = root / ".pi" / "sessions"
    if ss.is_dir():
        shutil.copytree(ss, capture_dir / "sessions")
    if bulletin_root.is_dir():
        shutil.copytree(bulletin_root, capture_dir / "bulletin" / session)
    log(f"captured -> {capture_dir}/  (sessions, bulletin, pane transcript)")
    log(f"cleanup: tmux kill-session -t {session} (run manually)")


if __name__ == "__main__":
    main()
