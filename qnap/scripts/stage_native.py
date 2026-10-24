#!/usr/bin/env python3
"""Stage an ordinary native QPKG payload with relocatable private ELF loaders."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "build/upstream"
OUTPUT = ROOT / "build/qpkg"
PATCHELF = os.environ.get("PATCHELF", "patchelf")
if OUTPUT.exists():
    shutil.rmtree(OUTPUT)
shutil.copytree(ROOT / "qpkg", OUTPUT, symlinks=True)
SHARED = OUTPUT / "shared"
shutil.copytree(SOURCE / "app", SHARED / "server", symlinks=True)
(SHARED / "runtime/bin").mkdir(parents=True)
(SHARED / "runtime/lib").mkdir(parents=True)
(SHARED / "runtime/certs").mkdir(parents=True)
(OUTPUT / "x86_64").mkdir()
(OUTPUT / "x86_64/.target").write_text("x86_64\n")
shutil.copy2(SOURCE / "usr/local/bin/node", SHARED / "runtime/bin/node")
for directory in (SOURCE / "lib", SOURCE / "usr/lib"):
    for source in directory.iterdir():
        if source.name.startswith(("ld-musl-", "libc.musl-", "libstdc++", "libgcc_s")):
            destination = SHARED / "runtime/lib" / source.name
            if source.is_symlink():
                destination.symlink_to(os.readlink(source))
            else:
                shutil.copy2(source, destination)
libc_link = SHARED / "runtime/lib/libc.musl-x86_64.so.1"
if not libc_link.exists():
    libc_link.symlink_to("ld-musl-x86_64.so.1")
shutil.copy2(SOURCE / "etc/ssl/certs/ca-certificates.crt", SHARED / "runtime/certs")

# Preserve every bundled license plus Node's license payload.
licenses = SHARED / "runtime/licenses"
licenses.mkdir()
for item in (ROOT / "third-party").iterdir():
    if item.is_file():
        shutil.copy2(item, licenses / item.name)
for item in (SOURCE / "usr/local/LICENSE", SOURCE / "usr/local/share/doc/node/LICENSE"):
    if item.is_file():
        shutil.copy2(item, licenses / "NODE-LICENSE")
if not (licenses / "NODE-LICENSE").is_file():
    raise RuntimeError("Node runtime license was not found")
shutil.copy2(ROOT / "upstream.lock.json", SHARED / "upstream.lock.json")
shutil.copy2(SOURCE / "release-identity.json", SHARED / "release-identity.json")
shutil.copy2(ROOT / "LICENSE", SHARED / "PACKAGING-LICENSE")
shutil.copy2(ROOT / "README.md", SHARED / "README.QNAP.md")
shutil.copy2(ROOT / "README.zh-CN.md", SHARED / "README.QNAP.zh-CN.md")

placeholder = "/MOTRIX_PRIVATE_RUNTIME/" + "x" * 360
for relative in ("runtime/bin/node", "server/bin/aria2c", "server/bin/motrix-finalize-fs"):
    binary = SHARED / relative
    data = binary.read_bytes()
    offset = struct.unpack_from("<Q", data, 32)[0]
    size, count = struct.unpack_from("<HH", data, 54)
    dynamic = any(struct.unpack_from("<I", data, offset + i * size)[0] == 3 for i in range(count))
    if dynamic:
        rpath = "$ORIGIN/../lib" if relative.startswith("runtime/") else "$ORIGIN/../../runtime/lib"
        subprocess.run([PATCHELF, "--set-interpreter", placeholder, "--set-rpath", rpath, str(binary)], check=True)
        print("Prepared private interpreter:", relative)
    else:
        print("Static executable:", relative)

for name in ("MotrixServer.sh", "libexec/run-server.sh", "bin/node", "bin/motrix-admin"):
    (SHARED / name).chmod(0o755)
for name in ("runtime/bin/node", "runtime/lib/ld-musl-x86_64.so.1", "server/bin/aria2c", "server/bin/motrix-finalize-fs"):
    (SHARED / name).chmod(0o755)

# Keep the QNAP share browser reproducible when staging a clean release.
subprocess.run(["python3", str(ROOT / "scripts/apply_qnap_browser.py"), str(SHARED / "server")], check=True)

files = {}
for file in sorted(SHARED.rglob("*")):
    if file.is_file() and not file.is_symlink():
        with file.open("rb") as stream:
            files[file.relative_to(SHARED).as_posix()] = hashlib.file_digest(stream, "sha256").hexdigest()
(SHARED / "payload-checksums.json").write_text(json.dumps(files, indent=2) + "\n")
print(f"Native payload ready: {SHARED}")
