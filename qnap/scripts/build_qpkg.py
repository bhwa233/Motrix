#!/usr/bin/env python3
"""Build the native x86_64 installer using pinned upstream QDK scripts."""
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
LOCK = json.loads((ROOT / "upstream.lock.json").read_text())
TOOLS = ROOT / "build/tools/qdk"
FILES = {
    "shared/bin/qbuild": "bin/qbuild",
    "shared/scripts/qinstall.sh": "scripts/qinstall.sh",
    "shared/template/qpkg.cfg": "template/qpkg.cfg",
    "shared/template/package_routines": "template/package_routines",
    "src/qpkg_encrypt.c": "src/qpkg_encrypt.c",
}
provenance = {}
for source, relative in FILES.items():
    destination = TOOLS / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    url = f"https://raw.githubusercontent.com/qnap-dev/QDK/{LOCK['qdkRevision']}/{source}"
    with urllib.request.urlopen(url, timeout=45) as response:
        data = response.read()
    destination.write_bytes(data)
    destination.chmod(0o755)
    provenance[source] = hashlib.sha256(data).hexdigest()
(TOOLS / "qdk.conf").write_text('QDK_VERSION="2.5.3"\n')
(TOOLS / "source-checksums.json").write_text(json.dumps(provenance, indent=2) + "\n")
# QDK's pipe-fed dd counts short reads as blocks, truncating the payload on
# GNU/Linux. Copy the exact byte length instead; QTS provides /usr/bin/head.
qbuild = TOOLS / "bin/qbuild"
text = qbuild.read_text()
old = r'/bin/dd if="\${0}" bs=\$offset skip=1 | /bin/cat | /bin/dd bs=1024 count=$((($data_len + 1023) / 1024)) of=\$_EXTRACT_DIR/$QDK_COMPRESS_FILE || exit 1'
new = r'/bin/dd if="\${0}" bs=\$offset skip=1 | /usr/bin/head -c $data_len > \$_EXTRACT_DIR/$QDK_COMPRESS_FILE || exit 1'
if text.count(old) != 1:
    raise RuntimeError("Pinned QDK extraction header did not match")
qbuild.write_text(text.replace(old, new))
subprocess.run([os.environ.get("CC", "cc"), "-O2", "-o", str(TOOLS / "bin/qpkg_encrypt"), str(TOOLS / "src/qpkg_encrypt.c")], check=True)

DIST = ROOT / "dist"
DIST.mkdir(exist_ok=True)
environment = dict(os.environ, QDK_PATH=str(TOOLS), PATH=str(TOOLS / "bin") + os.pathsep + os.environ["PATH"])
command = [str(TOOLS / "bin/qbuild"), "--root", str(ROOT / "build/qpkg"), "--build-dir", str(DIST), "--build-arch", "x86_64", "--gzip"]
if not shutil.which("fakeroot"):
    raise RuntimeError("fakeroot is required to give installed program files root ownership")
subprocess.run(["fakeroot", "--", "sh", "-c", "chown -R 0:0 " + shlex.quote(str(ROOT / "build/qpkg")) + " && exec " + shlex.join(command)], check=True, env=environment)
packages = sorted(DIST.glob("*.qpkg"))
if len(packages) != 1:
    raise RuntimeError("Expected exactly one QPKG")
package = packages[0]
with package.open("rb") as stream:
    digest = hashlib.file_digest(stream, "sha256").hexdigest()
(DIST / (package.name + ".sha256")).write_text(f"{digest}  {package.name}\n")
subprocess.run([str(TOOLS / "bin/qbuild"), "--query", "info", str(package)], check=True, env=environment)
print(f"Installer ready: {package}\nSHA-256: {digest}")
