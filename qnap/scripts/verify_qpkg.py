#!/usr/bin/env python3
"""Verify QPKG byte boundaries, payload integrity, ownership and runtime assets."""
import gzip
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import sys
import tarfile

package = Path(sys.argv[1])
data = package.read_bytes()
header = data[:data.index(b"\nexit 1\n") + 8].decode()
header_length = int(re.search(r"^script_len=(\d+)$", header, re.M)[1])
control_length = int(re.search(r"offset=\$\(/usr/bin/expr \$script_len \+ (\d+)\)", header)[1])
payload_length = int(re.search(r"/usr/bin/head -c (\d+) >", header)[1])
assert header_length == len(header.encode()), "Incorrect self-extraction header length"
start = header_length + control_length
compressed = data[start:start + payload_length]
payload = gzip.decompress(compressed)
with tarfile.open(fileobj=io.BytesIO(payload), mode="r:") as archive:
    observed = {}
    for item in archive:
        relative = item.name.removeprefix("./")
        name = PurePosixPath(relative)
        assert not name.is_absolute() and ".." not in name.parts, "Unsafe payload path"
        assert item.uid == 0 and item.gid == 0, f"Non-root program ownership: {relative}"
        if not item.issym():
            assert not item.mode & 0o022, f"Program file is group/world writable: {relative}"
        if item.isfile():
            content = archive.extractfile(item).read()
            observed[relative] = hashlib.sha256(content).hexdigest()
            if relative == "payload-checksums.json":
                checksums = json.loads(content)
    for name, expected in checksums.items():
        assert observed.get(name) == expected, f"Payload checksum mismatch: {name}"
    for name in ["MotrixServer.sh", "runtime/bin/node", "runtime/lib/ld-musl-x86_64.so.1", "runtime/licenses/NODE-LICENSE", "runtime/licenses/MUSL-COPYRIGHT", "runtime/licenses/GCC-RUNTIME-LIBRARY-EXCEPTION", "server/bin/aria2c", "server/bin/motrix-finalize-fs", "server/dist/server/index.mjs", "server/dist/server/qnap-directories.mjs", "server/dist/server/persistent-operator-sessions.mjs", "server/dist/renderer-web/index.html", "server/dist/renderer-web/assets/qnap-clipboard-v1.js", "server/node_modules/better-sqlite3/prebuilds/linuxmusl-x64.node"]:
        assert name in observed, f"Missing required runtime asset: {name}"
print(json.dumps({"ok": True, "file": package.name, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data), "payloadBytes": len(payload), "verifiedFiles": len(checksums), "rootOwnership": True, "exactPayloadBoundary": True}, indent=2))
