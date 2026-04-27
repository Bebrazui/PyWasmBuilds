"""
WASM Extension Import Hook
--------------------------
Registered into sys.meta_path at CPython initialisation time.
Intercepts `import` statements for modules whose backing implementation is a
.so file (C-extension compiled to wasm32-wasi) and delegates the actual
loading to the WASMExtensionLoader instance injected by the JS host as the
``__wasm_loader__`` builtin.
"""

import sys
import importlib.abc
import importlib.machinery


class WASMExtensionFinder(importlib.abc.MetaPathFinder):
    """MetaPathFinder that resolves C-extension modules via WASMExtensionLoader."""

    def find_spec(self, fullname, path, target=None):
        """
        Return a ModuleSpec if WASMExtensionLoader knows about this module,
        otherwise return None to let the normal import machinery continue.
        """
        loader = self._get_loader()
        if loader is None:
            return None

        # Ask the JS loader whether a .so is registered for this module.
        # The loader exposes `isRegistered(soPath)` but we only have the
        # module name here; the JS side resolves the mapping internally.
        # We use a lightweight probe: try to get a spec only when the loader
        # has something registered (checked via the JS bridge attribute).
        if not hasattr(loader, 'isRegisteredModule'):
            # Fallback: always defer to normal machinery when the bridge
            # doesn't expose the helper method yet.
            return None

        if not loader.isRegisteredModule(fullname):
            return None

        return importlib.machinery.ModuleSpec(
            fullname,
            _WASMExtensionLoader(fullname, loader),
            is_package=False,
        )

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _get_loader():
        """Return the __wasm_loader__ builtin injected by the JS host, or None."""
        builtins_obj = __builtins__
        # __builtins__ can be either the builtins module or its __dict__
        if isinstance(builtins_obj, dict):
            return builtins_obj.get('__wasm_loader__')
        return getattr(builtins_obj, '__wasm_loader__', None)


class _WASMExtensionLoader(importlib.abc.Loader):
    """Loader that calls WASMExtensionLoader.load() on the JS side."""

    def __init__(self, fullname, js_loader):
        self._fullname = fullname
        self._js_loader = js_loader

    def create_module(self, spec):
        # Return None to use default module creation semantics.
        return None

    def exec_module(self, module):
        """
        Delegate execution to the JS WASMExtensionLoader.
        The JS side is responsible for instantiating the WASM module and
        populating the Python module object via the C API.
        """
        if hasattr(self._js_loader, 'execModule'):
            self._js_loader.execModule(self._fullname, module)


# ─── Registration ─────────────────────────────────────────────────────────────

# Insert at position 0 so our finder runs before the standard finders.
sys.meta_path.insert(0, WASMExtensionFinder())
