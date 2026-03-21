import sys
from pathlib import Path

# Ensure `import api.*` works (agent.py uses relative imports).
APPS_DIR = Path(__file__).resolve().parents[2]  # .../apps
if str(APPS_DIR) not in sys.path:
    sys.path.insert(0, str(APPS_DIR))

