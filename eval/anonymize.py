"""Replace private identifiers in public eval data using an untracked mapping."""

import json
import os
import re
from pathlib import Path

# Raw PR exports and the corresponding substitutions must stay outside this repository.
MAPPING_FILE = Path(os.environ.get("EVAL_REDACTIONS_FILE", "/tmp/canopy-data/redactions.json"))
if not MAPPING_FILE.is_file():
    raise FileNotFoundError(f"Private redaction mapping required: {MAPPING_FILE}")
mapping = json.loads(MAPPING_FILE.read_text())
if not isinstance(mapping, dict) or not mapping or any(
    not isinstance(source, str) or not source or not isinstance(replacement, str) or not replacement
    for source, replacement in mapping.items()
):
    raise ValueError(f"Invalid private redaction mapping: {MAPPING_FILE}")
REPLACEMENTS = tuple(
    (re.compile(re.escape(source), re.IGNORECASE), replacement)
    for source, replacement in mapping.items()
)


def redact(value):
    if isinstance(value, str):
        for pattern, replacement in REPLACEMENTS:
            value = pattern.sub(replacement, value)
        return value
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, dict):
        return {key: redact(item) for key, item in value.items()}
    return value
