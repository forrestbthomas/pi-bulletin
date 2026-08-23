#!/usr/bin/env python3
"""run-leg.py — drive one eval leg for the pi-bulletin vs pi-teams comparison.

Authoritative protocol: docs/EVAL-PLAN.md (rev 2). This script automates the
helper's share: tmux setup, agent launch, prompt injection, attach, capture,
cleanup. The human still drives the agents inside tmux; the script waits at
`tmux attach` and resumes capture when you detach (Ctrl-b d).

Python 3 stdlib only (no pip deps). Why Python and not bash: macOS ships
bash 3.2 whose parser breaks on associative arrays and heredocs inside
`$(...)`; Python avoids that class of bug entirely.

Usage:
    ./run-leg.py <A|B|C|D> [--dryrun]

    A = pi-teams    on harness  (try-pi-teams worktree,   team teams-harness)
    B = pi-bulletin on harness  (spike-bulletin-protocol, team pb-harness)
    C = pi-teams    on cobra    (try-pi-teams worktree,   team teams-cobra)
    D = pi-bulletin on cobra    (spike-bulletin-protocol, team pb-cobra)

    --dryrun: 0.5 pre-flight — 2 roles, trivial task.

Env prereqs: tmux, pi-run on PATH, BW_SESSION set (refresh before each leg).

Why pi-run and not bare `pi`: pi-run resolves pi via the absolute nvm path
(so PATH is irrelevant), injects NODE_OPTIONS ipv4first, pins the provider/
model (eval fairness invariant), and writes the .pi cost ledger as a
cross-check for the token metric. pi-teams teammate relaunch uses
`node <cli.js>` internally, so it works when the lead was started by pi-run.

Env propagation: tmux panes do NOT inherit BW_SESSION from the client shell
by default, so pi-run's secret-manager key resolution would fail in the
pane. The script passes BW_SESSION through `tmux new-session -e` so every
pane in the session can resolve keys.
"""

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
PKG_DIR = SCRIPT_DIR.parent
EVAL_OUT = PKG_DIR / "eval-output"
TARGETS = EVAL_OUT / "targets"

# --- leg matrix -------------------------------------------------------------
LEG_CONFIG = {
    "A": dict(wt="/Users/forrestthomas/Projects/harness/.worktrees/try-pi-teams",
              proto="teams", tgt="harness", session="teams-harness"),
    "B": dict(wt="/Users/forrestthomas/Projects/harness/.worktrees/spike-bulletin-protocol",
              proto="bulletin", tgt="harness", session="pb-harness"),
    "C": dict(wt="/Users/forrestthomas/Projects/harness/.worktrees/try-pi-teams",
              proto="teams", tgt="cobra", session="teams-cobra"),
    "D": dict(wt="/Users/forrestthomas/Projects/harness/.worktrees/spike-bulletin-protocol",
              proto="bulletin", tgt="cobra", session="pb-cobra"),
}

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

# Verbatim from EVAL-PLAN.md — do not reword.
TASK_PROMPT = """Perform a read-only parallel review of this codebase. Do NOT modify any files.
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
coordination quality (did the team's communication help or thrash?)."""

TRIVIAL_TASK = ("Read-only: look at the README of this repo and report one thing "
                "you notice. Do NOT modify any files.")

# Harness-native launcher with the plan's pinned model (fairness invariant).
# Explicit --model overrides any default; thinking level comes from the
# worktree's .pi/settings.json (defaultThinkingLevel: medium).
# Provider route: OPENROUTER (OpenAI direct credits exhausted 2026-08-23; the
# openrouter provider's defaultModel is the SAME id, so the pinned model is
# unchanged — only the route differs). Results are OpenRouter-routed; if the
# eval is re-run on OpenAI direct, re-baseline.
LAUNCH = "pi-run chat --provider openrouter --model openai/gpt-5.6-terra"

# --- tmux helpers -----------------------------------------------------------
def tmux(args, capture=False, timeout=60):
    cmd = ["tmux"] + args
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0 and not capture:
        raise RuntimeError(f"tmux {' '.join(args)} failed: {r.stderr.strip()}")
    return r

def die_if_session_dead(session, what):
    """After launching panes, verify the session survived startup; a pane
    command that exits immediately (e.g. pi-run chat failing key resolution)
    kills the session. Fail loudly with the pane's last output instead of
    timing out silently."""
    time.sleep(3)
    if pane_exists(session):
        return
    log("session died during startup — capturing last pane output:")
    try:
        out = tmux(["capture-pane", "-p", "-t", session], capture=True).stdout or ""
        print((out or "")[-800:])
    except RuntimeError:
        pass
    die(f"{what}: tmux session '{session}' exited during startup. Most likely "
        "pi-run chat could not resolve the API key in the pane. From your shell "
        "check: bw_get OPENAI_API_KEY (item name may differ) and that BW_SESSION "
        "is current (bw unlock).")

def pane_exists(session):
    return tmux(["has-session", "-t", session], capture=True).returncode == 0

def probe_pane(pane, exit_marker, timeout_s=90):
    """Wait for pi's TUI to render. Returns (status, last_output):
    'ready' when a ready marker appears, 'dead' when the pane prints the
    exit trap (pi-run chat exited), 'timeout' otherwise. Always keeps the
    last captured output for diagnostics.

    Ready markers: pi's prompt glyph where present (❯/>), plus the pinned
    model string from the TUI status bar (observed in pi 0.84.1 captures —
    the status bar renders 'openrouter/openai/gpt-5.6-terra:medium' with no
    visible prompt glyph)."""
    waited = 0
    last = ""
    while waited < timeout_s:
        out = tmux(["capture-pane", "-p", "-t", pane], capture=True).stdout or ""
        if exit_marker in out:
            return "dead", out
        if "❯" in out or ">" in out or "gpt-5.6-terra" in out:
            return "ready", out
        if out:
            last = out
        time.sleep(2)
        waited += 2
    return "timeout", last

def show_pane_tail(out, n=30):
    lines = [l for l in (out or "").splitlines() if l.strip()]
    print("\n".join(lines[-n:]))

def type_lines(pane, text):
    """Send multi-line text to a pane, one line at a time (Enter per line)."""
    for line in text.splitlines() or [""]:
        tmux(["send-keys", "-t", pane, line if line else " ", "Enter"])

# --- capture helpers --------------------------------------------------------
def archive_sessions(wt, leg_dir):
    ss = Path(wt) / ".pi" / "sessions"
    if not ss.is_dir():
        return
    pre = leg_dir / "sessions-pre"
    pre.mkdir(parents=True, exist_ok=True)
    for f in list(ss.iterdir()):
        if f.is_file():
            shutil.move(str(f), str(pre / f.name))
    log(f"archived pre-leg session files -> {pre}/")

def capture_sessions(wt, leg_dir):
    """Copy session files into a fresh per-run dir. copytree into a reused
    dir (dirs_exist_ok=True) would MERGE with a previous run's files and
    pollute the token sum (observed: dry-run sessions leaking into the real
    leg). Use a timestamped dir so reruns never contaminate each other."""
    ss = Path(wt) / ".pi" / "sessions"
    if not ss.is_dir():
        return
    out = leg_dir / f"sessions-{time.strftime('%Y%m%d-%H%M%S')}"
    shutil.copytree(ss, out)
    n = sum(1 for _ in out.rglob("*.jsonl"))
    log(f"captured session files -> {out}/ ({n} jsonl)")

def capture_pi_teams_state(session, leg_dir):
    out = leg_dir / "teams-state"
    out.mkdir(parents=True, exist_ok=True)
    home = Path.home()
    team_home = home / ".pi" / "teams" / session
    tasks_home = home / ".pi" / "tasks" / session
    if team_home.is_dir():
        shutil.copytree(team_home, out / session, dirs_exist_ok=True)
        log(f"captured team config/inboxes -> {out}/")
    if tasks_home.is_dir():
        shutil.copytree(tasks_home, out / "tasks", dirs_exist_ok=True)
        log(f"captured task board -> {out}/tasks")
    cfg = out / session / "config.json"
    if cfg.is_file():
        log("model/thinking/cwd verification:")
        try:
            data = json.loads(cfg.read_text())
            for m in data.get("members", []):
                print(f"  {m.get('name')}: model={m.get('model')} "
                      f"thinking={m.get('thinking')} cwd={m.get('cwd')}")
        except (json.JSONDecodeError, OSError) as e:
            log(f"WARN: could not parse config.json: {e}")

def capture_bulletin_state(bulletin_root, leg_dir):
    out = leg_dir / "bulletin"
    out.mkdir(parents=True, exist_ok=True)
    if bulletin_root.is_dir():
        shutil.copytree(bulletin_root, out / bulletin_root.name, dirs_exist_ok=True)
        log(f"captured bulletin substrate -> {out}/")
    log("bulletin status (event/digest counts):")
    for name in ("events.jsonl", "digests.jsonl"):
        f = bulletin_root / name
        if f.is_file():
            print(f"  {name}: {sum(1 for _ in f.open())} lines")

def capture_pane_transcript(session, leg_dir):
    r = tmux(["capture-pane", "-p", "-t", session, "-S", "-2000"], capture=True)
    (leg_dir / "pane-transcript.txt").write_text(r.stdout or "")
    log(f"pane transcript -> {leg_dir}/pane-transcript.txt")

def write_measurements_template(leg, proto, tgt, tgt_path, leg_dir, dryrun):
    sha = "unknown"
    try:
        sha = subprocess.run(["git", "-C", str(tgt_path), "rev-parse", "HEAD"],
                             capture_output=True, text=True, timeout=30).stdout.strip() or sha
    except (subprocess.SubprocessError, OSError):
        pass
    (leg_dir / "measurements.md").write_text(
        f"""# Leg {leg} — {proto} on {tgt}{' (DRY-RUN)' if dryrun else ''}

| metric | value |
|---|---|
| protocol / target / target SHA | {proto} / {tgt} / `{sha}` |
| wall-clock (start→done) | started {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} |
| total tokens (sum .pi/sessions Usage) | (fill: `python3 scripts/tokens.py {leg_dir / 'sessions'}`) |
| coordination events | (fill) |
| coordination LLM turns | (fill) |
| conflicts detected | (fill; bulletin only) |
| output quality (blinded judge 0–1) | (fill after Phase 3.3) |
| MAST failure-mode counts | (fill after Phase 3.2) |
| session file list | see {leg_dir / 'sessions'}/ |
"""
    )
    log(f"measurements template -> {leg_dir}/measurements.md")

def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)

def die(msg):
    print(f"ERROR: {msg}", file=sys.stderr, flush=True)
    sys.exit(1)

# --- main -------------------------------------------------------------------
def main():
    if len(sys.argv) < 2 or sys.argv[1].upper() not in LEG_CONFIG:
        print("usage: ./run-leg.py <A|B|C|D> [--dryrun]")
        sys.exit(1)
    leg = sys.argv[1].upper()
    dryrun = "--dryrun" in sys.argv[2:]
    cfg = LEG_CONFIG[leg]
    wt = Path(cfg["wt"])
    proto, tgt, session = cfg["proto"], cfg["tgt"], cfg["session"]
    leg_dir = EVAL_OUT / f"leg-{leg.lower()}"
    tgt_path = TARGETS / tgt

    # 0. env checks
    if not shutil.which("tmux"):
        die("tmux not on PATH")
    if not shutil.which("pi-run"):
        die("pi-run not on PATH (install via brew: brew install pi-harness)")
    if not os.environ.get("BW_SESSION"):
        die("BW_SESSION not set — run: bw unlock")
    if not wt.is_dir():
        die(f"worktree {wt} missing")
    if not tgt_path.is_dir():
        die(f"target checkout {tgt_path} missing (run Phase 0.4)")
    if pane_exists(session):
        die(f"tmux session '{session}' already exists — pick a fresh team or clean up")
    leg_dir.mkdir(parents=True, exist_ok=True)
    (EVAL_OUT / "bulletin").mkdir(parents=True, exist_ok=True)

    # session hygiene before EVERY leg
    archive_sessions(wt, leg_dir)

    log(f"leg {leg}: {proto} on {tgt} — session {session}, worktree {wt}")
    log(f"review target: {tgt_path}")

    if proto == "teams":
        # pi-teams manages its own panes; we only start the lead. The pane
        # command carries an exit trap: if pi-run chat exits, the pane prints
        # LEAD_EXITED=<code> and sleeps instead of closing, so the probe can
        # surface the real error instead of timing out silently.
        lead_cmd = f"{LAUNCH}; echo LEAD_EXITED=$?; sleep 600"
        # Size the detached session explicitly: tmux defaults new sessions to
        # 80x24, which is too small for pi-teams to split into its own panes.
        tmux(["new-session", "-d", "-x", "240", "-y", "60",
              "-e", f"BW_SESSION={os.environ['BW_SESSION']}",
              "-s", session, "-c", str(wt), lead_cmd])
        status, out = probe_pane(session, "LEAD_EXITED")
        if status == "dead":
            show_pane_tail(out)
            die(f"lead pane exited during startup (LEAD_EXITED) — see output above")
        if status == "timeout":
            log("WARN: pi prompt not detected (startup may be slow); sending spawn anyway")
        if dryrun:
            type_lines(session, (
                f"Create a team named '{session}' using openrouter/openai/gpt-5.6-terra with "
                "medium thinking. "
                "Spawn 2 teammates IN THE CURRENT WORKING DIRECTORY: a lead-synthesizer and a "
                "bug-hunter, with the role instructions. Then review the README of the target at "
                f"{tgt_path} and report one thing you notice. Do NOT modify any files."
            ))
        else:
            type_lines(session, (
                f"Create a team named '{session}' using openrouter/openai/gpt-5.6-terra with "
                "medium thinking. "
                f"Spawn all 5 teammates IN THE CURRENT WORKING DIRECTORY ({wt}): a "
                "lead-synthesizer, a bug-hunter, a complexity-analyst, a security-spotter, and a "
                "devil-advocate, each with their role instruction. The ONLY review target is the "
                f"checkout at {tgt_path} (read-only, do NOT modify any files). DO NOT explore "
                "node_modules, .pi/, .worktrees/, eval-output/, or pi's own runtime docs — ignore "
                "them entirely and review only the target checkout.\n{TASK_PROMPT}"
            ))
        log("lead prompted. Attaching — drive the team; detach with Ctrl-b d when done.")
        tmux(["attach", "-t", session], timeout=None)
        capture_pane_transcript(session, leg_dir)
        # pi-teams capture ordering matters: inboxes/task-board state can be
        # removed by shutdown/cleanup, so capture teams-state FIRST; teammate
        # session files only flush to .pi/sessions when the teammate process
        # exits, so shut the team down gracefully BEFORE capturing sessions.
        capture_pi_teams_state(session, leg_dir)
        input("[helper] If teammates are still running, ask the lead to shut the team "
              "down gracefully (this flushes their session files), then press Enter... ")
        capture_sessions(wt, leg_dir)
    else:
        # pi-bulletin: N panes, one Pi session per role, shared bulletin root.
        bulletin_root = EVAL_OUT / "bulletin" / session
        bulletin_root.mkdir(parents=True, exist_ok=True)
        role_count = 2 if dryrun else 5
        # panes carry an exit trap so a dying pi-run chat prints PANE_EXITED
        # and keeps the pane alive instead of silently closing the window.
        env0 = (f"env PI_BULLETIN_AGENT={ROLES[0]} "
                f"PI_BULLETIN_ROOT={bulletin_root} {LAUNCH}; echo PANE_EXITED=$?; sleep 600")
        # Size the detached session explicitly (default 80x24 cannot fit 5
        # panes); panes reflow to the client's size on attach.
        tmux(["new-session", "-d", "-x", "240", "-y", "60",
              "-e", f"BW_SESSION={os.environ['BW_SESSION']}",
              "-s", session, "-c", str(wt), env0])
        for i in range(1, role_count):
            env_i = (f"env PI_BULLETIN_AGENT={ROLES[i]} "
                     f"PI_BULLETIN_ROOT={bulletin_root} {LAUNCH}; echo PANE_EXITED=$?; sleep 600")
            try:
                tmux(["split-window", "-t", session, "-c", str(wt), env_i])
            except RuntimeError as e:
                # clean up the partial session so the guard doesn't block a rerun
                tmux(["kill-session", "-t", session], capture=True)
                die(f"could not create {role_count} panes: {e}. The detached "
                    "session is sized 240x60; if this persists, your tmux "
                    "window is too small — run in a larger terminal.")
        tmux(["select-layout", "-t", session, "tiled"])
        time.sleep(1)
        for i in range(role_count):
            pane = f"{session}.{i}"
            role = ROLES[i]
            rp = ROLE_PROMPT[role]
            status, out = probe_pane(pane, "PANE_EXITED")
            if status == "dead":
                show_pane_tail(out)
                die(f"pane {pane} exited during startup (PANE_EXITED) — see output above")
            if status == "timeout":
                log(f"WARN: pane {pane} prompt not detected; sending anyway")
            extra = TRIVIAL_TASK if dryrun else ""
            if i == 0:
                type_lines(pane, (
                    f"You are {role}. {rp} Use the bulletin tools (bulletin_status, "
                    "bulletin_post, bulletin_read, bulletin_conflicts, bulletin_sync) for ALL "
                    "team coordination — never direct-message other agents. Team name: "
                    f"{session}. Review the codebase at {tgt_path} (read-only). As lead, run "
                    "bulletin_conflicts then bulletin_sync at each round end. "
                    f"{extra}"
                ))
            else:
                type_lines(pane, (
                    f"You are {role}. {rp} Use the bulletin tools for ALL team coordination. "
                    f"Team name: {session}. Review the codebase at {tgt_path} (read-only). Post "
                    "findings with bulletin_post(kind=finding, ref=topic, claim=one-liner). "
                    f"{extra}"
                ))
        log(f"{role_count} panes launched. Attaching — watch the team; detach with Ctrl-b d when done.")
        tmux(["attach", "-t", session], timeout=None)
        capture_pane_transcript(session, leg_dir)
        capture_sessions(wt, leg_dir)
        capture_bulletin_state(bulletin_root, leg_dir)

    write_measurements_template(leg, proto, tgt, tgt_path, leg_dir, dryrun)
    log(f"cleanup: tmux kill-session -t {session} (run manually)")
    log(f"done. Fill {leg_dir}/measurements.md and report back for capture verification.")


if __name__ == "__main__":
    main()
