"""Faceplate platform plugin package.

Hermes' plugin loader requires every user plugin under ~/.hermes/plugins/
to be an importable Python package — i.e. have an ``__init__.py``. The
adapter implementation lives in :mod:`.adapter`; we re-export the
gateway-facing :func:`register` symbol here so the loader can find it
whether it imports the package or the module.
"""

from .adapter import FaceplateAdapter, register

__all__ = ["FaceplateAdapter", "register"]
