# Motrix Server native QPKG

Independent QNAP packaging of Motrix Server **2.0.0-beta.52** for **x86_64**.
It runs directly on QTS with a private Node.js 24 / musl runtime. Docker,
Container Station, Entware, Python and a system-wide Node.js installation are
not required on the NAS.

The first supported test platform is a QNAP TS-451D running QTS 5.2.10. Other
x86_64 models require their own acceptance checks. This is a beta package,
not an official QNAP or Motrix distribution.

## Release inputs

`upstream.lock.json` pins the official Motrix multi-platform release index,
its amd64 manifest and the source revision. `scripts/fetch_upstream.py` verifies
the SHA-256 of every manifest, configuration and layer before extracting only
the application and native runtime files. The OCI registry is used as a
release artifact source; no container is created or executed, including during
the build. The published application is reused without modifying its source.

The private ELF interpreter is reserved at build time and relocated to the
actual QPKG path during preparation. Node then executes directly with its own
runtime libraries, preserving `process.execPath`, child processes, worker
threads and the musl SQLite module. QTS system libraries are not replaced.

QDK 2.5.3 is pinned separately. The builder compiles its QPKG checksum utility
and uses fakeroot to package root-owned program files. A narrowly scoped QDK
header adaptation copies the exact payload byte count with `head -c` instead
of counting short pipe reads with `dd`; package verification checks those byte
boundaries and all payload checksums.

## Build

On a Linux build host, install Python 3.11+, a C compiler, rsync, fakeroot and
patchelf. No NAS development tools are needed.

```sh
python3 scripts/fetch_upstream.py
python3 scripts/stage_native.py
python3 scripts/build_qpkg.py
python3 scripts/verify_qpkg.py dist/MotrixServer_2.0.0.58_x86_64.qpkg
```

Set `PATCHELF` to an executable path when it is not on PATH. Build inputs are
cached under `cache/`; generated files go to `build/` and `dist/`. The installer
and a SHA-256 file are emitted in `dist/`.

## Installation and access

Install the QPKG through App Center's manual installation action and choose
the installation volume. Local packages have no QNAP signing certificate;
App Center may require its manual installation option for unsigned packages.

The package defaults to the NAS `admin` account (UID 0) and its primary group.
Program files remain owned by root. The Web interface uses port **16880**; the separate MDXP
listener uses loopback port **16881**, and the managed aria2 RPC uses loopback
port **16800** by default. Ports must be free. Opening the App Center icon
launches the Web interface in a browser tab.

The first Web visit requires the generated operator token. Retrieve it over
SSH using the package's registered data directory:

```sh
MOTRIX_STATE=$(/sbin/getcfg MotrixServer Data_Dir -f /etc/config/qpkg.conf)
cat "$MOTRIX_STATE/operator-token"
```

The token file has mode 0600. Do not publish its contents. The Web interface
uses Motrix's own authentication; a QTS login does not automatically unlock it.

## Storage and configuration

By default, state is stored outside the application directory at
`<installation-volume>/.motrix-server`. Downloads use the Download shared
folder's `Motrix` subdirectory. Only that new subdirectory is assigned to the
service account; the package never recursively changes the shared folder's
ownership. Administrator mode can use existing writable NAS shares without
recursively changing their permissions.

New download files are readable and writable by the directory's shared group.
State directories are restricted to the service account and administrators;
operator credentials retain their explicit 0600 permissions.

Administrative settings live in `<Install_Path>/etc/motrix.conf` and survive
normal in-place upgrades through QDK's configuration preservation mechanism.
Stop the service before changing `PORT`, `MDXP_PORT`, `DATA_DIR`,
`DOWNLOAD_DIR`, `PUBLIC_URL` or `HOST_LANGUAGE`, then start it again. Keep this
file owned by root because the service control script reads it.

Use a state directory on a volume with working, reasonably fast synchronous
writes. Both the application and its aria2 fork use persistent SQLite data.
An overloaded volume can exceed upstream engine startup limits even when the
CPU and runtime are compatible. Moving an installation to another volume
requires an explicit state migration or an explicit `DATA_DIR`; it must not
silently open a different empty profile.

```sh
MOTRIX_INSTALL=$(/sbin/getcfg MotrixServer Install_Path -f /etc/config/qpkg.conf)
"$MOTRIX_INSTALL/MotrixServer.sh" status
"$MOTRIX_INSTALL/MotrixServer.sh" stop
"$MOTRIX_INSTALL/MotrixServer.sh" start
```

The service waits for `/healthz` to report that the application and engine are
ready. Stop sends SIGTERM and waits up to 120 seconds for persistence and
engine shutdown. Log output is written to `<Data_Dir>/logs/server.log`.

Uninstallation retains state, downloaded files and the service account so
existing file ownership remains meaningful. Back up administrative configuration
separately before uninstalling. Back up state with the service stopped.

## Verification

`verify_qpkg.py` checks the actual compressed payload boundaries, gzip stream,
root ownership, file permissions, mandatory native assets and per-file SHA-256.
`smoke-runtime.mjs` checks the real private executable, expected runtime identity,
child processes, worker threads and a SQLite WAL close/reopen round trip.
`tests/native-fixture.mjs` supplies loopback HTTP range transfers, a BitTorrent
tracker/peer and BEP 9 metadata without depending on external downloads.

Runtime and acceptance results are kept separately under ignored `evidence/`.
No SSH passwords or operator tokens belong in this repository or its reports.

## Licenses

The packaging source is MIT licensed. The payload includes Motrix's complete
third-party notices, the Node.js license inventory, musl's copyright notice,
and GCC's license and Runtime Library Exception. QDK's installer is distributed
under its upstream GPL terms; its pinned source remains available at
https://github.com/qnap-dev/QDK.

## QNAP share browser revision

QPKG 2.0.0.53 keeps upstream Motrix Server beta.52 and adds a native NAS share catalog, existing subdirectory navigation and filesystem permission checks. `patches/qnap-directories.mjs` is integrated into the pinned release by `scripts/apply_qnap_browser.py`. Read-only browsing does not grant write access. The frontend JS module graph uses revised URLs to avoid stale cached imports. See README.zh-CN.md for details.

## Administrator default (QPKG 2.0.0.54)

At the NAS owner request, the default runtime account is now admin (UID 0), using its primary group. Existing share permissions are left unchanged; the server and child download processes inherit administrator filesystem access. Operator authentication remains required. Update RUN_USER in retained installation configuration when upgrading an older install.

## Remember login (QPKG 2.0.0.58)

Operator browser sessions last one year and survive application restarts. The server stores only hashes of random session IDs and expiry timestamps in a private 0600 operator-sessions.json file. Logout revokes the session durably; token rotation invalidates old sessions. Cookie clearing, private browsing, a different hostname/IP or expiry still requires a new login. The operator token is never copied into localStorage.

## Fork layout and custom operator tokens

Run the build commands from this `qnap/` directory. The parent checkout retains
upstream source history; release inputs remain pinned by `upstream.lock.json`.
The adapter is deliberately version-specific and rejects unexpected bundles.

For a custom operator token, stop the service, write the value to a private
regular file, and set `OPERATOR_TOKEN_FILE` in `etc/motrix.conf` to its absolute
path. The launcher enforces mode 0600 and supplies the value through upstream's
`MOTRIX_OPERATOR_TOKEN` interface. Leave the setting empty for automatic token
provisioning. Do not store real credentials in Git. This is an independent
Motrix credential and does not synchronize with the QTS admin password.

A successful browser login lasts one year and survives service restarts.
Logout, browser data removal, expiration, or token rotation requires a new
login. Session state stores hashes rather than raw cookies.

DHT bootstrap address overrides are optional NAS configuration. No router or
proxy changes are included, and no speed improvement is guaranteed.

HTTP NAS pages include a clipboard write fallback for browsers that omit the secure-context Clipboard API. Copy remains a user-triggered action; browser refusal is reported as a failure. Upgrades restore customized administrative configuration when QDK moves it aside because packaged defaults changed.
