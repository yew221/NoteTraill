#!/usr/bin/env python3
"""T01-E: isolated macOS Keychain fixture; never queries the real DeepSeek item."""
import ctypes as C
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
SERVICE = b"com.notetrail.t01.synthetic-only"
ACCOUNT = b"public-fixture"
PASSWORD = b"PUBLIC_KEYCHAIN_TEST_PASSWORD"
FIRST = b"PUBLIC_SYNTHETIC_CREDENTIAL_V1"
SECOND = b"PUBLIC_SYNTHETIC_CREDENTIAL_V2"


def target_path(run_dir):
    directory = Path(run_dir)
    assert directory.is_dir() and directory.resolve() == directory, "run directory must be real"
    assert directory.parent == ROOT / "outputs/t01/storage", "unexpected run directory"
    target = directory / "probe.keychain-db"
    assert not target.exists() and not target.is_symlink(), "never reuse a keychain"
    return target


def configuration():
    # Compare only in memory; do not record names of unrelated user keychains.
    return tuple(subprocess.run(["/usr/bin/security", *args], capture_output=True,
        check=True, timeout=5).stdout for args in [("list-keychains", "-d", "user"), ("default-keychain", "-d", "user")])


def run(run_dir):
    target = target_path(run_dir)
    result = {"passed": False, "checks": [], "statuses": {}, "syntheticOnly": True}
    security = C.CDLL("/System/Library/Frameworks/Security.framework/Security")
    core = C.CDLL("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation")
    ptr, u32, boolean = C.c_void_p, C.c_uint32, C.c_ubyte

    def bind(name, *args):
        function = getattr(security, name)
        function.argtypes, function.restype = args, C.c_int32
        return function

    get_ui = bind("SecKeychainGetUserInteractionAllowed", C.POINTER(boolean))
    set_ui = bind("SecKeychainSetUserInteractionAllowed", boolean)
    create = bind("SecKeychainCreate", C.c_char_p, u32, C.c_char_p, boolean, ptr, C.POINTER(ptr))
    open_keychain = bind("SecKeychainOpen", C.c_char_p, C.POINTER(ptr))
    remove_keychain = bind("SecKeychainDelete", ptr)
    lock = bind("SecKeychainLock", ptr)
    unlock = bind("SecKeychainUnlock", ptr, u32, C.c_char_p, boolean)
    add = bind("SecKeychainAddGenericPassword", ptr, u32, C.c_char_p, u32, C.c_char_p, u32, C.c_char_p, C.POINTER(ptr))
    find = bind("SecKeychainFindGenericPassword", ptr, u32, C.c_char_p, u32, C.c_char_p, C.POINTER(u32), C.POINTER(ptr), ptr)
    modify = bind("SecKeychainItemModifyAttributesAndData", ptr, ptr, u32, C.c_char_p)
    remove_item = bind("SecKeychainItemDelete", ptr)
    free = bind("SecKeychainItemFreeContent", ptr, ptr)
    core.CFRelease.argtypes, core.CFRelease.restype = [ptr], None
    keychain, item, missing = ptr(), ptr(), ptr()
    old_ui = boolean()
    before = configuration()
    created = False
    ui_saved = False

    def check(name, condition):
        assert condition, name
        result["checks"].append(name)

    def ok(name, status):
        result["statuses"][name] = status
        check(name, status == 0)

    def read(ref):
        assert ref.value, "never search the default keychain list"
        length, data = u32(), ptr()
        status = find(ref, len(SERVICE), SERVICE, len(ACCOUNT), ACCOUNT, C.byref(length), C.byref(data), None)
        try:
            value = C.string_at(data, length.value) if status == 0 else None
            return status, value
        finally:
            if data.value:
                free(None, data)

    try:
        ok("读取原交互设置", get_ui(C.byref(old_ui)))
        ui_saved = True
        ok("测试进程禁用密码弹窗", set_ui(False))
        ok("创建独立测试钥匙串", create(bytes(target), len(PASSWORD), PASSWORD, False, None, C.byref(keychain)))
        check("只使用新建钥匙串的有效引用", bool(keychain.value))
        created = True
        ok("解锁测试钥匙串", unlock(keychain, len(PASSWORD), PASSWORD, True))
        ok("保存合成凭据", add(keychain, len(SERVICE), SERVICE, len(ACCOUNT), ACCOUNT, len(FIRST), FIRST, C.byref(item)))
        check("只操作新建条目的有效引用", bool(item.value))
        status, value = read(keychain)
        ok("读取已保存条目", status)
        check("读取值与合成输入一致", value == FIRST)
        ok("更新同一条目", modify(item, None, len(SECOND), SECOND))
        status, value = read(keychain)
        check("更新后读取到新值", status == 0 and value == SECOND)
        ok("锁定独立测试钥匙串", lock(keychain))
        status, value = read(keychain)
        result["statuses"]["locked_read"] = status
        check("锁定时无弹窗返回失败且无凭据", status != 0 and value is None)
        result["statuses"]["wrong_unlock"] = unlock(keychain, 5, b"wrong", True)
        check("错误密码不能解锁", result["statuses"]["wrong_unlock"] != 0)
        ok("正确密码重新解锁", unlock(keychain, len(PASSWORD), PASSWORD, True))
        status, value = read(keychain)
        check("恢复可用后读取正常", status == 0 and value == SECOND)
        ok("删除合成凭据条目", remove_item(item))
        status, value = read(keychain)
        result["statuses"]["deleted_read"] = status
        check("删除后明确未找到而非返回旧值", status == -25300 and value is None)
        absent = target.parent / "does-not-exist.keychain-db"
        status = open_keychain(bytes(absent), C.byref(missing))
        if status == 0:
            status, value = read(missing)
        result["statuses"]["unavailable_read"] = status
        check("不可用路径明确失败且不创建替代存储", status != 0 and not absent.exists())
        result["passed"] = True
    except Exception as error:
        result["error"] = {"type": type(error).__name__, "message": str(error)}
    finally:
        if item.value:
            core.CFRelease(item)
        if missing.value:
            core.CFRelease(missing)
        cleanup = remove_keychain(keychain) if created else 0
        if keychain.value:
            core.CFRelease(keychain)
        restored_ui = set_ui(old_ui) if ui_saved else 0
        result["cleanup"] = {"keychainDeleted": cleanup == 0 and not target.exists(),
            "interactionRestored": restored_ui == 0, "configurationUnchanged": configuration() == before}
        result["passed"] = result["passed"] and all(result["cleanup"].values())
        with (target.parent / "keychain.json").open("x") as stream:
            json.dump(result, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
    return result


if __name__ == "__main__":
    assert len(sys.argv) == 2, "usage: keychain_probe.py RUN_DIRECTORY"
    sys.exit(0 if run(sys.argv[1])["passed"] else 1)
