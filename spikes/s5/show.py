#!/usr/bin/env python3
"""Render observed provider values without guessing missing quota. No network requests."""
import json
from pathlib import Path

snapshot = json.loads(Path(__file__).with_name('observed.json').read_text())
reports = snapshot['reports']
for provider in ('openai-codex', 'anthropic', 'databricks'):
    matches = [row for row in reports if row['provider'] == provider]
    if not matches:
        print(f'{provider}: 未知（沒有 provider report）')
        continue
    for report in matches:
        for limit in report.get('limits', []):
            amount = limit.get('amount', {})
            remaining = amount.get('remaining')
            value = f"{remaining} {amount.get('unit', '')}" if isinstance(remaining, (int, float)) else '未知'
            print(f"{provider}/{limit['window']['id']}: remaining={value}; fetchedAt={report['fetchedAt']}; resetsAt={limit['window'].get('resetsAt', '未知')}")
for account in snapshot['accountsWithoutUsage']:
    print(f"{account['provider']}: 另有帳號額度未知（accountsWithoutUsage，不與已知帳號合併）")
