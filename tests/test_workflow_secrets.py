"""Standing rule: secret-using workflows never run on pull_request. A workflow a
pull request can start may not read a secret, pass secrets to a reusable
workflow, or inherit them; the full with-secrets runs go on push to main and
by hand (e.g. replay-check.yml with replay-check-pr.yml)."""

import re
from pathlib import Path

import pytest
import yaml

WORKFLOWS = sorted(Path(".github/workflows").glob("*.yml"))


def _triggers(doc: dict) -> set[str]:
    on = doc.get("on", doc.get(True))  # YAML 1.1 reads a bare `on` as True
    if isinstance(on, str):
        return {on}
    return set(on or {})


@pytest.mark.parametrize("path", WORKFLOWS, ids=lambda p: p.name)
def test_pull_request_workflows_use_no_secrets(path):
    text = path.read_text()
    doc = yaml.safe_load(text)
    if not _triggers(doc) & {"pull_request", "pull_request_target"}:
        return
    assert not re.search(r"secrets\.\w", text), (
        f"{path.name} runs on pull requests and reads a secret"
    )
    for name, job in (doc.get("jobs") or {}).items():
        assert "secrets" not in job, f"{path.name} job {name} passes secrets to {job.get('uses')}"


def test_the_pr_gates_still_run_on_pull_requests():
    """The bit-identical replay gate and the sandbox gate kept their PR runs."""
    for name in ("replay-check-pr.yml", "sandbox-pr.yml"):
        doc = yaml.safe_load(Path(".github/workflows", name).read_text())
        assert "pull_request" in _triggers(doc)
