"""Disposable multi-profile fixture for the Sidebar Tidy E2E.

Clones the schema of a freshly initialised Hermes state.db (template) into
default + two named profiles and inserts a few titled sessions in each.
Stdlib only: usage  python3 fixture_sql.py <template state.db> <HERMES_HOME>
"""
import json
import shutil
import sqlite3
import sys
import time
from pathlib import Path

template, home = Path(sys.argv[1]), Path(sys.argv[2])
plan = {
    'default': ['Plan weekend hike', 'Fix router DNS'],
    'research': ['Survey GPU rental prices', 'Compare vector DBs'],
    'writing': ['Draft essay on toys'],
}

# Flatten the template (WAL -> main file) and blank it.
src = sqlite3.connect(template)
src.execute('PRAGMA wal_checkpoint(TRUNCATE)')
src.close()
blank = home.parent / 'blank-state.db'
shutil.copy(template, blank)
b = sqlite3.connect(blank)
b.execute('DELETE FROM messages')
b.execute('DELETE FROM sessions')
b.commit()
b.execute('VACUUM')
b.close()

now = time.time()
n = 0
for profile, titles in plan.items():
    root = home if profile == 'default' else home / 'profiles' / profile
    root.mkdir(parents=True, exist_ok=True)
    (root / 'config.yaml').touch()
    for suffix in ('', '-wal', '-shm'):
        Path(f'{root / "state.db"}{suffix}').unlink(missing_ok=True)
    shutil.copy(blank, root / 'state.db')
    db = sqlite3.connect(root / 'state.db')
    for j, title in enumerate(titles):
        n += 1
        sid = f'sbt-{profile}-{j}'
        t = now - n * 600
        db.execute(
            'INSERT INTO sessions (id, source, model, started_at, message_count, title, last_activity_at, profile_name)'
            ' VALUES (?, ?, ?, ?, 2, ?, ?, ?)',
            (sid, 'desktop', 'fixture-model', t, title, t + 5, profile),
        )
        db.execute("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, 'user', ?, ?)", (sid, f'fixture: {title}', t))
        db.execute("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, 'assistant', 'ok', ?)", (sid, t + 5))
    if profile == 'default':
        # One cron run so the Cron jobs section exists for the section tests.
        n += 1
        t = now - n * 600
        db.execute(
            'INSERT INTO sessions (id, source, model, started_at, message_count, title, last_activity_at, profile_name)'
            " VALUES ('sbt-cron-0', 'cron', 'fixture-model', ?, 2, 'Nightly digest', ?, 'default')",
            (t, t + 5),
        )
        db.execute("INSERT INTO messages (session_id, role, content, timestamp) VALUES ('sbt-cron-0', 'user', 'fixture: cron', ?)", (t,))
        db.execute("INSERT INTO messages (session_id, role, content, timestamp) VALUES ('sbt-cron-0', 'assistant', 'ok', ?)", (t + 5,))
    db.commit()
    db.close()

# One PAUSED cron job so the sidebar renders its Cron jobs section. Paused and
# disabled: the isolated scheduler never fires it.
(home / 'cron').mkdir(exist_ok=True)
(home / 'cron' / 'jobs.json').write_text(json.dumps({'jobs': [{
    'id': 'sbtfixture01', 'name': 'Nightly digest', 'prompt': 'fixture', 'skills': [], 'skill': None,
    'model': None, 'provider': None, 'base_url': None,
    'schedule': {'kind': 'cron', 'expr': '0 3 * * *', 'display': '0 3 * * *'}, 'schedule_display': '0 3 * * *',
    'repeat': {'times': None, 'completed': 1}, 'enabled': False, 'state': 'paused',
    'paused_at': '2026-01-01T00:00:00+00:00', 'paused_reason': 'fixture', 'created_at': '2026-01-01T00:00:00+00:00',
    'next_run_at': None, 'last_run_at': None, 'last_status': None, 'last_error': None, 'deliver': 'local', 'origin': None,
}], 'updated_at': '2026-01-01T00:00:00+00:00'}, indent=2))
print(f'fixture ok: {n} sessions across {len(plan)} profiles, 1 paused cron job')
