"""Mitmproxy script entrypoint.

Keep implementation in an importable module. Mitmproxy executes ``-s`` scripts
outside the normal import registry, which breaks annotation-aware dataclasses
on current Python releases when they are declared directly in the script.
"""

from addons.maintainflow_policy import MaintainFlowPolicy


addons = [MaintainFlowPolicy()]
