#!/usr/bin/env python3
"""S7 offline usage adapter probe. Reads existing JSONL; never starts a CLI or child.
Not a lifecycle/heartbeat adapter. Prints counters only, never conversation content.
Usage: python3 spikes/s7/usage_probe.py codex|claude TRANSCRIPT.jsonl
"""
import collections
import hashlib
import json
from pathlib import Path
import sys


def number(usage, field):
    value = usage.get(field)
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ValueError(f'unknown/invalid usage field: {field}')
    return value


def normalize(cli, usage):
    if cli == 'codex':
        total = number(usage, 'input_tokens')
        cache = number(usage, 'cached_input_tokens')
        if cache > total:
            raise ValueError('cached input exceeds total input')
        # cache writes are explicit in this version; absent is unknown, not zero.
        write = number(usage, 'cache_write_input_tokens')
        if cache + write > total:
            raise ValueError('cache read/write exceeds total input')
        return (total - cache - write, cache, write, number(usage, 'output_tokens'))
    return (number(usage, 'input_tokens'), number(usage, 'cache_read_input_tokens'),
            number(usage, 'cache_creation_input_tokens'), number(usage, 'output_tokens'))


def scan(cli, file):
    versions = set()
    records = {}
    counts = collections.Counter()
    usage_rows = 0
    latest_codex_total = None
    unknown = 0
    sha = hashlib.sha256()
    with file.open('rb') as f:
        for line in f:
            sha.update(line)
            event = json.loads(line)
            typ = event.get('type')
            counts[typ] += 1
            if cli == 'codex':
                payload = event.get('payload', {})
                if typ == 'session_meta':
                    versions.add(payload.get('cli_version', 'unknown'))
                if typ == 'event_msg' and payload.get('type') == 'token_count' and payload.get('info'):
                    latest_codex_total = payload['info'].get('total_token_usage')
                if typ != 'token_usage_record':
                    continue
                key = payload.get('response_id')
                usage = payload.get('usage')
            else:
                if event.get('version'):
                    versions.add(event['version'])
                if typ != 'assistant':
                    continue
                payload = event.get('message', {})
                key = payload.get('id')
                usage = payload.get('usage')
            if usage is None:
                continue
            usage_rows += 1
            if not key:
                unknown += 1
                continue
            # Replace repeated snapshots of the same message/response; never add twice.
            try:
                records[key] = normalize(cli, usage)
            except ValueError:
                records[key] = None
    unknown += sum(value is None for value in records.values())
    totals = tuple(sum(value[i] for value in records.values() if value is not None) for i in range(4))
    if cli == 'codex' and latest_codex_total:
        assert totals == normalize(cli, latest_codex_total), (totals, normalize(cli, latest_codex_total))
    return {'cli': cli, 'versions': sorted(versions), 'sourceSHA256': sha.hexdigest(),
            'usageRows': usage_rows, 'uniqueUsageIds': len(records), 'unknownUsageEntries': unknown,
            'usage': dict(zip(('inputNonCache', 'cacheRead', 'cacheWrite', 'output'), totals)),
            'cost': 'unknown', 'recordCounts': dict(counts),
            'codexCumulativeCrossCheck': cli == 'codex' and latest_codex_total is not None,
            'limits': ['offline usage only', 'no live resume/abort/child or bash-env proof', 'no heartbeat or durable event/ack writer']}


if __name__ == '__main__':
    if len(sys.argv) != 3 or sys.argv[1] not in ('codex', 'claude'):
        raise SystemExit(__doc__)
    print(json.dumps(scan(sys.argv[1], Path(sys.argv[2])), ensure_ascii=False, indent=2))
