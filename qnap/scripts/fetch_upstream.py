#!/usr/bin/env python3
"""Recover verified native release files without installing a container engine."""
import concurrent.futures
import hashlib
import json
from pathlib import Path, PurePosixPath
import shutil
import tarfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
LOCK = json.loads((ROOT / "upstream.lock.json").read_text())
CACHE = ROOT / "cache" / "oci"
OUTPUT = ROOT / "build" / "upstream"
CACHE.mkdir(parents=True, exist_ok=True)
BASE = f"https://{LOCK['registry']}/v2/{LOCK['repository']}"
AUTH_URL = (
    "https://auth.docker.io/token?service=registry.docker.io&scope=repository:"
    + LOCK["repository"] + ":pull"
)
with urllib.request.urlopen(AUTH_URL, timeout=30) as response:
    ACCESS = json.load(response)["token"]
HEADERS = {
    "Authorization": "Bearer " + ACCESS,
    "Accept": "application/vnd.oci.image.index.v1+json,application/vnd.oci.image.manifest.v1+json",
}


def verified_download(kind, digest):
    algorithm, hexdigest = digest.split(":", 1)
    if algorithm != "sha256" or len(hexdigest) != 64:
        raise ValueError("Expected a SHA-256 digest")
    destination = CACHE / hexdigest
    if destination.is_file() and hashlib.file_digest(destination.open("rb"), "sha256").hexdigest() == hexdigest:
        return destination
    temporary = destination.with_suffix(".partial")
    for attempt in range(4):
        try:
            request = urllib.request.Request(f"{BASE}/{kind}/{digest}", headers=HEADERS)
            with urllib.request.urlopen(request, timeout=120) as response, temporary.open("wb") as target:
                shutil.copyfileobj(response, target)
            with temporary.open("rb") as source:
                actual = hashlib.file_digest(source, "sha256").hexdigest()
            if actual != hexdigest:
                raise ValueError(f"Digest mismatch: {digest}")
            temporary.replace(destination)
            print(f"Verified {digest} ({destination.stat().st_size:,} bytes)", flush=True)
            return destination
        except Exception:
            temporary.unlink(missing_ok=True)
            if attempt == 3:
                raise
            time.sleep(2 ** attempt)


index = json.loads(verified_download("manifests", LOCK["indexDigest"]).read_bytes())
platform = next(item for item in index["manifests"] if item.get("platform") == {"architecture": LOCK["architecture"], "os": "linux"})
if platform["digest"] != LOCK["manifestDigest"]:
    raise ValueError("Platform manifest does not match lock")
manifest = json.loads(verified_download("manifests", LOCK["manifestDigest"]).read_bytes())
config = json.loads(verified_download("blobs", manifest["config"]["digest"]).read_bytes())
labels = config["config"]["Labels"]
if labels["org.opencontainers.image.revision"] != LOCK["sourceRevision"] or labels["org.opencontainers.image.version"] != LOCK["version"]:
    raise ValueError("Release identity does not match lock")
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    layers = list(pool.map(lambda item: verified_download("blobs", item["digest"]), manifest["layers"]))

# Include only application files and the private runtime dependency closure.
# No root filesystem, container metadata, init system, or host library changes.
def selected(name):
    return (
        name == "app" or name.startswith("app/")
        or name == "usr/local/bin/node"
        or name.startswith("usr/local/share/doc/node/")
        or name == "usr/local/LICENSE"
        or name.startswith("lib/ld-musl-")
        or name.startswith("lib/libc.musl-")
        or name.startswith("usr/lib/libstdc++")
        or name.startswith("usr/lib/libgcc_s")
        or name == "etc/ssl/certs/ca-certificates.crt"
        or name.startswith("usr/share/licenses/")
    )


if OUTPUT.exists():
    shutil.rmtree(OUTPUT)
OUTPUT.mkdir(parents=True)
for layer in layers:
    with tarfile.open(layer, "r:gz") as archive:
        for member in archive:
            name = member.name.removeprefix("./")
            path = PurePosixPath(name)
            if path.is_absolute() or ".." in path.parts:
                raise ValueError("Unsafe archive path")
            if not selected(name):
                continue
            if path.name.startswith(".wh."):
                raise ValueError("Selected release tree contains an unsupported OCI whiteout")
            if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
                raise ValueError("Unexpected special file")
            archive.extract(member, OUTPUT, filter="data")

required = ["app/dist/server/index.mjs", "app/dist/renderer-web/index.html", "usr/local/bin/node", "lib/ld-musl-x86_64.so.1", "usr/lib/libstdc++.so.6", "usr/lib/libgcc_s.so.1", "app/bin/aria2c", "app/bin/motrix-finalize-fs"]
for item in required:
    if not (OUTPUT / item).is_file():
        raise ValueError(f"Missing required native file: {item}")
(OUTPUT / "release-identity.json").write_text(json.dumps({**LOCK, "environment": config["config"]["Env"]}, indent=2) + "\n")
print(f"Native release files ready: {OUTPUT}", flush=True)
