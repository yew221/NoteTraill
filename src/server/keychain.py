"""Bounded stdin/stdout bridge to macOS Keychain. Never prints native errors."""
import ctypes as C
import json
import re
import sys

SERVICE = re.compile(r"com\.notetrail\.model\.[0-9a-f]{64}\Z")
ACCOUNT = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\Z")


def valid_secret(value):
    return isinstance(value, str) and 16 <= len(value) <= 512 and all(33 <= ord(c) <= 126 for c in value)


def operate(request, isolated_keychain=None):
    """The optional native reference is used only by isolated tests, never by the CLI."""
    if not isinstance(request, dict) or request.get("op") not in ("write", "read", "remove"):
        return {"ok": False, "error": "invalid_request"}
    expected = {"op", "service", "account"} | ({"secret"} if request["op"] == "write" else set())
    if set(request) != expected or not isinstance(request.get("service"), str) or not SERVICE.fullmatch(request["service"]) or \
            not isinstance(request.get("account"), str) or not ACCOUNT.fullmatch(request["account"]) or \
            (request["op"] == "write" and not valid_secret(request["secret"])):
        return {"ok": False, "error": "invalid_request"}
    if sys.platform != "darwin" or sys.version_info[:2] != (3, 12):
        return {"ok": False, "error": "unavailable"}
    security = C.CDLL("/System/Library/Frameworks/Security.framework/Security")
    core = C.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
    ptr = C.c_void_p

    def bind(lib, name, result, *arguments):
        function = getattr(lib, name)
        function.restype, function.argtypes = result, arguments
        return function

    string = bind(core, "CFStringCreateWithCString", ptr, ptr, C.c_char_p, C.c_uint32)
    data = bind(core, "CFDataCreate", ptr, ptr, C.c_char_p, C.c_long)
    dictionary = bind(core, "CFDictionaryCreate", ptr, ptr, C.POINTER(ptr), C.POINTER(ptr), C.c_long, ptr, ptr)
    array = bind(core, "CFArrayCreate", ptr, ptr, C.POINTER(ptr), C.c_long, ptr)
    release = bind(core, "CFRelease", None, ptr)
    length = bind(core, "CFDataGetLength", C.c_long, ptr)
    bytes_pointer = bind(core, "CFDataGetBytePtr", ptr, ptr)
    add = bind(security, "SecItemAdd", C.c_int32, ptr, C.POINTER(ptr))
    read = bind(security, "SecItemCopyMatching", C.c_int32, ptr, C.POINTER(ptr))
    remove = bind(security, "SecItemDelete", C.c_int32, ptr)
    get_ui = bind(security, "SecKeychainGetUserInteractionAllowed", C.c_int32, C.POINTER(C.c_ubyte))
    set_ui = bind(security, "SecKeychainSetUserInteractionAllowed", C.c_int32, C.c_ubyte)
    constant = lambda name, lib=security: ptr.in_dll(lib, name).value
    owned = []

    def own(reference):
        if not reference:
            raise RuntimeError("native_allocation_failed")
        owned.append(reference)
        return reference

    previous_ui, ui_saved = C.c_ubyte(), False
    try:
        if get_ui(C.byref(previous_ui)) != 0:
            return {"ok": False, "error": "unavailable"}
        ui_saved = True
        # Process-local setting: fail when interaction is needed; do not change the user's Keychain settings.
        if set_ui(False) != 0:
            return {"ok": False, "error": "unavailable"}
        pairs = {
            constant("kSecClass"): constant("kSecClassGenericPassword"),
            constant("kSecAttrService"): own(string(None, request["service"].encode("ascii"), 0x08000100)),
            constant("kSecAttrAccount"): own(string(None, request["account"].encode("ascii"), 0x08000100)),
        }
        if isolated_keychain is not None:
            if not isolated_keychain.value:
                return {"ok": False, "error": "invalid_request"}
            if request["op"] == "write":
                pairs[constant("kSecUseKeychain")] = isolated_keychain.value
            else:
                refs = (ptr * 1)(isolated_keychain.value)
                pairs[constant("kSecMatchSearchList")] = own(array(None, refs, 1, None))
        if request["op"] == "write":
            secret = request["secret"].encode("ascii")
            pairs[constant("kSecValueData")] = own(data(None, secret, len(secret)))
        elif request["op"] == "read":
            pairs[constant("kSecReturnData")] = constant("kCFBooleanTrue", core)
            pairs[constant("kSecMatchLimit")] = constant("kSecMatchLimitOne")
        keys, values = (ptr * len(pairs))(*pairs.keys()), (ptr * len(pairs))(*pairs.values())
        query = own(dictionary(None, keys, values, len(pairs), None, None))
        result = ptr()
        if request["op"] == "write":
            status = add(query, None)
        elif request["op"] == "remove":
            status = remove(query)
        else:
            status = read(query, C.byref(result))
            if result.value:
                owned.append(result.value)
        if status == -25300:
            return {"ok": True} if request["op"] == "remove" else {"ok": False, "error": "missing"}
        if status != 0:
            return {"ok": False, "error": "unavailable"}
        if request["op"] == "read":
            size = length(result)
            if not 16 <= size <= 512:
                return {"ok": False, "error": "unavailable"}
            secret = C.string_at(bytes_pointer(result), size).decode("ascii")
            if not valid_secret(secret):
                return {"ok": False, "error": "unavailable"}
            return {"ok": True, "value": secret}
        return {"ok": True}
    finally:
        for reference in reversed(owned):
            release(reference)
        if ui_saved:
            set_ui(previous_ui)


def main():
    try:
        raw = sys.stdin.buffer.read(4097)
        if len(sys.argv) != 1 or len(raw) > 4096:
            result = {"ok": False, "error": "invalid_request"}
        else:
            result = operate(json.loads(raw))
    except Exception:
        result = {"ok": False, "error": "unavailable"}
    sys.stdout.write(json.dumps(result, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
