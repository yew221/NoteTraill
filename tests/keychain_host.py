"""Test-only host: explicit private Keychain reference, never the login Keychain."""
import ctypes as C
import importlib.util
import json
from pathlib import Path
import sys

PASSWORD = b"PUBLIC_ISOLATED_KEYCHAIN_PASSWORD"


def main(target, module_file):
    target = Path(target)
    assert target.name == "probe.keychain-db" and target.parent.resolve() == target.parent
    request = json.load(sys.stdin)
    security = C.CDLL("/System/Library/Frameworks/Security.framework/Security")
    core = C.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
    ptr = C.c_void_p

    def bind(name, *arguments):
        function = getattr(security, name)
        function.argtypes, function.restype = arguments, C.c_int32
        return function

    create = bind("SecKeychainCreate", C.c_char_p, C.c_uint32, C.c_char_p, C.c_ubyte, ptr, C.POINTER(ptr))
    open_keychain = bind("SecKeychainOpen", C.c_char_p, C.POINTER(ptr))
    unlock = bind("SecKeychainUnlock", ptr, C.c_uint32, C.c_char_p, C.c_ubyte)
    lock = bind("SecKeychainLock", ptr)
    remove = bind("SecKeychainDelete", ptr)
    get_ui = bind("SecKeychainGetUserInteractionAllowed", C.POINTER(C.c_ubyte))
    set_ui = bind("SecKeychainSetUserInteractionAllowed", C.c_ubyte)
    core.CFRelease.argtypes, core.CFRelease.restype = [ptr], None
    reference, previous = ptr(), C.c_ubyte()
    assert get_ui(C.byref(previous)) == 0
    assert set_ui(False) == 0
    try:
        if request.get("control") == "create":
            assert not target.exists() and not target.is_symlink()
            status = create(bytes(target), len(PASSWORD), PASSWORD, False, None, C.byref(reference))
        else:
            assert target.is_file() and not target.is_symlink()
            status = open_keychain(bytes(target), C.byref(reference))
        assert status == 0 and reference.value
        if "control" in request:
            if request["control"] in ("create", "unlock"):
                status = unlock(reference, len(PASSWORD), PASSWORD, True)
            elif request["control"] == "lock":
                status = lock(reference)
            elif request["control"] == "delete":
                status = remove(reference)
            else:
                raise ValueError("unknown control")
            result = {"ok": status == 0}
        else:
            spec = importlib.util.spec_from_file_location("notetrail_keychain", module_file)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            result = module.operate(request, reference)
        print(json.dumps(result))
    finally:
        if reference.value:
            core.CFRelease(reference)
        set_ui(previous)
