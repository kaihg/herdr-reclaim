#!/usr/bin/env python3
"""S8: real Git fixtures. No model calls; no user config or repository mutations."""
import json
import os
from pathlib import Path
import shutil
import statistics
import subprocess
import sys
import tempfile
import time

HOOKS = ('post-commit', 'post-merge', 'post-rewrite')
RESULT = {'git': subprocess.check_output(['git', '--version'], text=True).strip(), 'matrix': {}, 'checks': {}}
# Use the same recorder for every hook; post-rewrite must preserve stdin for chaining.
RECORDER = '''import json, os, pathlib, subprocess, sys, time
try:
    def git(*args):
        return subprocess.check_output(['git', *args], text=True).strip()
    hook = pathlib.Path(sys.argv[1])
    data = sys.stdin.read() if hook.name == 'post-rewrite' else ''
    old = hook.with_name(hook.name + '.original')
    if old.exists():
        subprocess.run([str(old), *sys.argv[2:]], input=data, text=True, check=False)
    record = dict(sha=git('rev-parse', 'HEAD'), hook=hook.name, args=sys.argv[2:], rewrite=data,
                  commonDir=git('rev-parse', '--path-format=absolute', '--git-common-dir'),
                  toplevel=git('rev-parse', '--show-toplevel'), at=time.time(),
                  env={k: os.environ.get(k) for k in ('PI_SESSION_ID', 'PI_TOOL_CALL_ID', 'CODEX_THREAD_ID', 'HC_TERMINAL_ID')})
    with open(os.environ['S8_LOG'], 'a') as f:
        f.write(json.dumps(record) + '\\n')
except Exception:
    pass
sys.exit(0)
'''


def main():
    with tempfile.TemporaryDirectory(prefix='reclaim-s8-') as tmp:
        root = Path(tmp)
        recorder = root / 'record.py'
        recorder.write_text(RECORDER)
        base_env = dict(os.environ, GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL='/dev/null',
                        GIT_TERMINAL_PROMPT='0', GIT_EDITOR='true', GIT_SEQUENCE_EDITOR='true')
        # Exclude inherited Git overrides; preserve genuine session evidence.
        for key in list(base_env):
            if key in ('GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE') or key.startswith('GIT_CONFIG_KEY_') or key.startswith('GIT_CONFIG_VALUE_') or key == 'GIT_CONFIG_COUNT':
                base_env.pop(key)

        class Repo:
            def __init__(self, name, hookspath=None):
                self.path = root / name
                self.path.mkdir()
                self.log = root / (name + '.jsonl')
                self.env = dict(base_env, S8_LOG=str(self.log))
                self.git('init', '-q', '-b', 'main')
                self.git('config', 'user.name', 'S8 fixture')
                self.git('config', 'user.email', 's8@example.invalid')
                self.git('config', 'commit.gpgsign', 'false')
                if hookspath:
                    self.git('config', 'core.hooksPath', hookspath)
                self.hooks = self.path / self.git('rev-parse', '--git-path', 'hooks')
                self.hooks.mkdir(parents=True, exist_ok=True)
                self.install()

            def git(self, *args, env=None, ok=True):
                p = subprocess.run(['git', *args], cwd=self.path, env=env or self.env,
                                   text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                if ok and p.returncode:
                    raise AssertionError(f'{args}: {p.stderr}')
                return p.stdout.strip() if ok else p

            def install(self):
                warnings = []
                if '.husky' in self.hooks.parts:
                    warnings.append('husky: explicit approval required')
                tracked = self.git('ls-files', '--', str(self.hooks))
                if tracked:
                    warnings.append('tracked hooks: explicit approval required')
                if warnings:
                    return warnings
                for name in HOOKS:
                    target = self.hooks / name
                    if target.exists():
                        target.rename(target.with_name(name + '.original'))
                    target.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{recorder}" "$0" "$@"\n')
                    target.chmod(0o755)
                return warnings

            def records(self):
                return [json.loads(s) for s in self.log.read_text().splitlines()] if self.log.exists() else []

            def commit(self, file, text, message='fixture', env=None):
                (self.path / file).write_text(text)
                self.git('add', '--', file)
                self.git('commit', '-qm', message, env=env)
                return self.git('rev-parse', 'HEAD')

            def measure(self, label, action, expected, paths=None):
                before = len(self.records())
                action()
                rows = self.records()[before:]
                names = [r['hook'] for r in rows]
                assert names == expected, (label, names, expected)
                sha = self.git('rev-parse', 'HEAD')
                for row in rows:
                    assert row['sha'] == sha, (label, row)
                parent = self.git('rev-parse', '--verify', 'HEAD^1', ok=False)
                args = ['diff-tree', '--no-commit-id', '-r', '-M', '--name-status']
                diff = self.git(*(args + ([sha + '^1', sha] if parent.returncode == 0 else ['--root', sha])))
                if paths is not None:
                    assert set(diff.splitlines()) == set(paths), (label, diff, paths)
                RESULT['matrix'][label] = {'hooks': names, 'diff': diff, 'rewrite': [r['rewrite'] for r in rows if r['rewrite']]}
                return rows

        r = Repo('matrix')
        initial = r.measure('initial', lambda: r.commit('a.txt', 'one\n'), ['post-commit'], ['A\ta.txt'])
        RESULT['checks']['bash_session_env'] = initial[0]['env']
        r.measure('commit', lambda: r.commit('a.txt', 'two\n'), ['post-commit'], ['M\ta.txt'])
        old = r.git('rev-parse', 'HEAD')
        rows = r.measure('amend', lambda: r.git('commit', '--amend', '-qm', 'amended'), ['post-commit', 'post-rewrite'], ['M\ta.txt'])
        assert rows[-1]['rewrite'].strip() == old + ' ' + r.git('rev-parse', 'HEAD')
        r.git('checkout', '-qb', 'feature')
        r.commit('f.txt', 'feature\n')
        old = r.git('rev-parse', 'HEAD')
        r.git('checkout', '-q', 'main')
        r.commit('m.txt', 'main\n')
        r.git('checkout', '-q', 'feature')
        # The merge backend invokes post-commit for each replayed commit.
        rows = r.measure('rebase', lambda: r.git('rebase', 'main'), ['post-commit', 'post-rewrite'], ['A\tf.txt'])
        assert rows[-1]['rewrite'].strip() == old + ' ' + r.git('rev-parse', 'HEAD')
        feature = r.git('rev-parse', 'HEAD')
        r.git('checkout', '-q', 'main')
        r.measure('cherry-pick', lambda: r.git('cherry-pick', feature), ['post-commit'], ['A\tf.txt'])
        r.git('checkout', '-q', 'feature')
        r.commit('extra.txt', 'extra\n')
        r.git('checkout', '-q', 'main')
        r.measure('merge-no-ff', lambda: r.git('merge', '--no-ff', 'feature', '-m', 'merge'), ['post-merge'], ['A\textra.txt'])
        r.git('checkout', '-qb', 'side')
        r.commit('conflict.txt', 'side\n')
        r.git('checkout', '-q', 'main')
        r.commit('conflict.txt', 'main\n')
        before = len(r.records())
        p = r.git('merge', 'side', ok=False)
        assert p.returncode == 1 and r.git('ls-files', '-u'), p
        assert len(r.records()) == before
        r.measure('merge-resolved', lambda: r.commit('conflict.txt', 'resolved\n'), ['post-commit'], ['M\tconflict.txt'])
        revert_target = r.commit('revert.txt', 'remove me\n')
        r.measure('revert', lambda: r.git('revert', '--no-edit', revert_target), ['post-commit'], ['D\trevert.txt'])
        # Disable hooks for one commit to exercise genuine reflog-only recovery.
        missing = r.commit('missed.txt', 'missed', env=dict(r.env, GIT_CONFIG_COUNT='1', GIT_CONFIG_KEY_0='core.hooksPath', GIT_CONFIG_VALUE_0='/dev/null'))
        assert missing in r.git('reflog', '--format=%H').splitlines()
        assert missing not in {row['sha'] for row in r.records()}
        RESULT['checks']['reflog_missing_hook'] = True
        r.git('mv', 'a.txt', 'renamed.txt')
        r.measure('rename', lambda: r.git('commit', '-qm', 'rename'), ['post-commit'], ['R100\ta.txt\trenamed.txt'])
        r.measure('empty', lambda: r.git('commit', '--allow-empty', '-qm', 'empty'), ['post-commit'], [])

        custom = Repo('custom', '.custom-hooks')
        for name in HOOKS:
            (custom.hooks / name).unlink()
        old_hook = custom.hooks / 'post-rewrite'
        chained = root / 'chain.txt'
        old_hook.write_text(f'#!/bin/sh\nprintf "%s\\n" "$*" >> "{chained}"\ncat >> "{chained}"\nexit 7\n')
        old_hook.chmod(0o755)
        assert custom.install() == []
        custom.commit('a', 'a')
        old = custom.git('rev-parse', 'HEAD')
        custom.git('commit', '--amend', '-qm', 'amend')
        new = custom.git('rev-parse', 'HEAD')
        assert chained.read_text() == f'amend\n{old} {new}\n'
        assert custom.records()[-1]['rewrite'] == f'{old} {new}\n'
        RESULT['checks']['hooksPath_chained_stdin_exit7'] = True
        husky = Repo('husky', '.husky/_')
        assert husky.install() and not (husky.hooks / 'post-commit').exists()
        RESULT['checks']['husky_refused_without_approval'] = True
        custom.git('add', '-f', '.custom-hooks')
        assert custom.install() == ['tracked hooks: explicit approval required']
        RESULT['checks']['tracked_hooks_refused'] = True

        identity = Repo('identity')
        # This subprocess completes while the enclosing real bash tool call is still active.
        ide_env = {k: v for k, v in identity.env.items() if k not in ('PI_SESSION_ID', 'PI_TOOL_CALL_ID', 'CODEX_THREAD_ID')}
        ide = identity.commit('ide', 'manual', env=ide_env)
        agent = identity.commit('agent', 'agent')
        records = {row['sha']: row for row in identity.records()}
        assert not records[ide]['env']['PI_SESSION_ID']
        assert records[agent]['env']['PI_SESSION_ID'] == os.environ.get('PI_SESSION_ID')
        RESULT['checks']['interleaved_IDE_no_session'] = records[ide]['env']
        RESULT['checks']['agent_session_available'] = bool(records[agent]['env']['PI_SESSION_ID'])
        nohook = identity.commit('nohook', 'nohook', env=dict(identity.env, GIT_CONFIG_COUNT='1', GIT_CONFIG_KEY_0='core.hooksPath', GIT_CONFIG_VALUE_0='/dev/null'))
        assert nohook not in {row['sha'] for row in identity.records()}
        assert nohook in identity.git('reflog', '--format=%H').splitlines()
        RESULT['checks']['nohook_has_no_attribution_evidence'] = True

        durations = []
        for _ in range(50):
            started = time.perf_counter()
            subprocess.run([str(r.hooks / 'post-commit')], cwd=r.path, env=r.env, check=True)
            durations.append((time.perf_counter() - started) * 1000)
        RESULT['hook_ms'] = {'n': len(durations), 'median': statistics.median(durations), 'p95': sorted(durations)[47], 'max': max(durations), 'all_under_50': max(durations) < 50}
        failed_env = dict(r.env, S8_LOG=str(root / 'absent' / 'log'))
        p = subprocess.run([str(r.hooks / 'post-commit')], cwd=r.path, env=failed_env)
        assert p.returncode == 0
        RESULT['checks']['write_failure_exit_zero'] = True
        RESULT['limits'] = ['Fixture installer/recorder, not production hook', 'No ledger exists: no-hook resource payout policy not executed', 'OMP commit namespace checked separately', 'Timing is sample evidence, not a hard real-time guarantee']
    print(json.dumps(RESULT, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    main()
