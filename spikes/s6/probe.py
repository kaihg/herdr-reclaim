#!/usr/bin/env python3
"""Launch OMP modes without prompts/model requests; isolated state and bounded lifetime."""
import json
import os
from pathlib import Path
import pty
import select
import subprocess
import sys
import tempfile
import time

extension = str(Path(__file__).with_name('context-probe.ts').resolve())
with tempfile.TemporaryDirectory(prefix='reclaim-s6-', dir='/tmp') as tmp:
    for name, args in [('print', ['--print']), ('rpc-headless', ['--mode', 'rpc', '--no-ui']), ('tui', [])]:
        if len(sys.argv) > 1 and name not in sys.argv[1:]:
            continue
        work = Path(tmp) / name
        work.mkdir()
        out = work / 'observed.jsonl'
        env = dict(os.environ, PI_CODING_AGENT_DIR=str(work / 'agent'), S6_PROBE_OUT=str(out), TERM='xterm-256color')
        for key in ('OMPCODE', 'HC_TERMINAL_ID', 'HERDR_SOCKET_PATH', 'HERDR_PANE_ID', 'HERDR_ENV'):
            env.pop(key, None)
        command = ['omp', '--cwd', str(work), '--no-extensions', '-e', extension, '--no-tools', '--no-skills', '--no-rules', '--no-context-files', '--no-title', '--no-lsp', '--max-time', '10', *args]
        if name != 'tui':
            # Startup requires a selection; no prompt is supplied and the extension shuts down.
            command += ['--model', 'openai/gpt-4o', '--api-key', 's6-not-a-real-credential']
        master, slave = pty.openpty()
        # TUI receives a real TTY, other modes receive closed stdin (no prompts).
        p = subprocess.Popen(command, env=env, stdin=slave if name == 'tui' else subprocess.DEVNULL, stdout=slave, stderr=slave)
        os.close(slave)
        transcript = bytearray()
        deadline = time.monotonic() + 25
        timed_out = False
        try:
            while p.poll() is None and time.monotonic() < deadline:
                readable, _, _ = select.select([master], [], [], 0.2)
                if readable:
                    try:
                        data = os.read(master, 65536)
                    except OSError:
                        break
                    transcript.extend(data)
            if p.poll() is None:
                timed_out = True
                p.terminate()
            try:
                p.wait(timeout=3)
            except subprocess.TimeoutExpired:
                p.kill()
                p.wait()
        finally:
            os.close(master)
        rows = [json.loads(line) for line in out.read_text().splitlines()] if out.exists() else []
        print(json.dumps({'scenario': name, 'exit': p.returncode, 'timed_out': timed_out, 'records': rows, 'diagnostic': transcript.decode(errors='replace')[-1500:] if not rows else None}, ensure_ascii=False))
