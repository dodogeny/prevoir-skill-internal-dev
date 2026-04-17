#!/bin/bash
# Resolve .env relative to this script's location (works in dev checkout or plugin install dir)
SCRIPT_DIR="$(cd "$(dirname "$(realpath "${BASH_SOURCE[0]}")")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$PROJECT_ROOT/.env"

if [ ! -f "$ENV_FILE" ]; then exit 0; fi

python3 - "$ENV_FILE" <<'PYEOF'
import json, sys, os

PATH_VARS = {"PRX_REPO_DIR", "PRX_KNOWLEDGE_DIR", "PRX_KB_LOCAL_CLONE", "CLAUDE_REPORT_DIR"}

env_file = sys.argv[1]
env_vars = {}
env_lines = []

with open(env_file) as f:
    for line in f:
        line = line.rstrip()
        if line and not line.startswith('#'):
            env_lines.append(line)
            if '=' in line:
                key, _, val = line.partition('=')
                env_vars[key.strip().lstrip('export ').strip()] = val.strip().strip('"').strip("'")

created = []
errors = []
unset = []

for var in PATH_VARS:
    if var not in env_vars:
        continue
    val = env_vars[var]
    if not val:
        unset.append(f"  {var} is set but has no value — please assign a path")
        continue
    path = os.path.expanduser(val)
    if not os.path.exists(path):
        try:
            os.makedirs(path, exist_ok=True)
            created.append(f"  {var}={val}")
        except Exception as e:
            errors.append(f"  {var}={val} (ERROR: {e})")

context = "Project .env loaded:\n" + "\n".join(env_lines)
parts = []
if created:
    parts.append("Created missing directories from .env:\n" + "\n".join(created))
if unset:
    parts.append("WARNING — path vars set but empty (no directory created):\n" + "\n".join(unset))
if errors:
    parts.append("ERROR — could not create directories:\n" + "\n".join(errors))

output = {
    "hookSpecificOutput": {
        "hookEventName": "SessionStart",
        "additionalContext": context
    }
}
if parts:
    output["systemMessage"] = "\n".join(parts)

print(json.dumps(output))
PYEOF
