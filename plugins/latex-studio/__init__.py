"""latex-studio: no-op CLI/gateway plugin.

The real logic lives in dashboard/plugin_api.py (FastAPI router mounted at
/api/plugins/latex-studio/ for the desktop plugin UI). This __init__ only
satisfies the plugin loader so `plugins.enabled` gating works cleanly.
"""


def register(ctx) -> None:  # noqa: ARG001
    return None
