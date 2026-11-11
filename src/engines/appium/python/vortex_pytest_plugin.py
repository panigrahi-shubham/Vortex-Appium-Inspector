"""Vortex pytest plugin, loaded only by the Vortex runner (``-p vortex_pytest_plugin``).

* Records the Appium session id of every test that uses a ``driver`` fixture, so Vortex can close
  sessions a cancelled or crashed run leaves behind.
* On a failed test, saves a screenshot and the page source next to the run report.

It never changes a test outcome: every error inside the plugin is swallowed and written to artifacts.jsonl.
Generated tests run fine without it (plain ``pytest test_x.py``).
"""

import json
import os
import re
import time

import pytest

_DIR = os.environ.get("VORTEX_ARTIFACTS")


def _write(name, record):
    if not _DIR:
        return
    try:
        with open(os.path.join(_DIR, name), "a", encoding="utf-8") as f:
            f.write(json.dumps(record) + "\n")
    except OSError:
        pass


def _driver(item):
    d = getattr(item, "funcargs", {}).get("driver")
    return d if d is not None and getattr(d, "session_id", None) else None


@pytest.hookimpl(hookwrapper=True)
def pytest_fixture_setup(fixturedef, request):
    """Measures how long the driver fixture (Appium session creation) took."""
    t0 = time.time()
    yield
    if fixturedef.argname == "driver":
        _write("sessions.jsonl", {"event": "driver-setup", "test": request.node.nodeid, "ms": round((time.time() - t0) * 1000)})


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_teardown(item, nextitem):
    """Measures the teardown phase (driver.quit() = Appium session cleanup, plus other finalizers)."""
    t0 = time.time()
    yield
    if "driver" in getattr(item, "fixturenames", ()):
        _write("sessions.jsonl", {"event": "teardown", "test": item.nodeid, "ms": round((time.time() - t0) * 1000)})


@pytest.hookimpl(tryfirst=True)
def pytest_runtest_call(item):
    d = _driver(item)
    if d is not None:
        _write("sessions.jsonl", {"event": "created", "session": d.session_id, "test": item.nodeid, "at": time.time()})


@pytest.hookimpl(hookwrapper=True)
def pytest_runtest_makereport(item, call):
    outcome = yield
    rep = outcome.get_result()
    if rep.when != "call" or not rep.failed or not _DIR:
        return
    d = _driver(item)
    if d is None:
        return
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", item.nodeid)[-120:]
    _write("artifacts.jsonl", {"type": "step", "test": item.nodeid, **getattr(d, "_vortex_step", {})})
    try:
        _write("artifacts.jsonl", {"type": "state", "test": item.nodeid, "package": d.current_package, "activity": d.current_activity, "context": d.context})
    except Exception as e:  # noqa: BLE001
        _write("artifacts.jsonl", {"type": "state-error", "test": item.nodeid, "error": str(e)[:300]})
    try:
        png = os.path.join(_DIR, f"failure-{safe}.png")
        if d.get_screenshot_as_file(png):
            _write("artifacts.jsonl", {"type": "screenshot", "test": item.nodeid, "file": os.path.basename(png)})
    except Exception as e:  # noqa: BLE001 - the plugin must never break a test run
        _write("artifacts.jsonl", {"type": "screenshot-error", "test": item.nodeid, "error": str(e)[:300]})
    try:
        xml = os.path.join(_DIR, f"failure-{safe}.xml")
        with open(xml, "w", encoding="utf-8") as f:
            f.write(d.page_source)
        _write("artifacts.jsonl", {"type": "page-source", "test": item.nodeid, "file": os.path.basename(xml)})
    except Exception as e:  # noqa: BLE001
        _write("artifacts.jsonl", {"type": "page-source-error", "test": item.nodeid, "error": str(e)[:300]})
