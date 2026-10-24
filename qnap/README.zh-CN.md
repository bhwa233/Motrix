# Motrix Server 原生 QPKG

这是面向 **x86_64 威联通 NAS** 的独立封装，基于 Motrix Server
**2.0.0-beta.52**。程序携带私有 Node.js 24 / musl 运行环境，直接运行在
QTS 上；NAS 无需 Docker、Container Station、Entware、Python 或全局 Node.js。

首个实机验证平台为 **TS-451D / QTS 5.2.10**。其他 x86_64 设备需要单独验证。
这是测试版安装包，并非 QNAP 或 Motrix 官方发行包。

## 构建来源

`upstream.lock.json` 锁定官方发布产物的索引、amd64 manifest 和源码提交。
下载脚本验证各 manifest、配置和文件层的 SHA-256，再提取应用及运行库。
OCI registry 仅作为发布文件来源，构建和运行均不创建或执行容器。上游应用
使用已发布产物，并通过版本锁定的局部补丁接入下述 NAS 目录浏览适配。

构建时为 ELF 私有加载器预留空间，安装准备阶段将其重定位到实际 QPKG 目录。
Node 随后通过自身运行库直接执行，保留正确的 `process.execPath`、子进程、
Worker 和 SQLite 行为。封装不替换 QTS 系统运行库。

QDK 2.5.3 同样锁定提交，构建时编译其 QPKG 校验工具，并使用 fakeroot 保证
安装的程序文件归 root 所有。构建脚本对 QDK 的数据提取头做了局部适配：
用 `head -c` 复制精确字节数，避免管道短读造成 `dd` 计数截断。校验脚本会
检查实际文件边界和所有负载校验值。

## 构建

Linux 构建机需要 Python 3.11+、C 编译器、rsync、fakeroot 和 patchelf。
NAS 无需开发工具。

```sh
python3 scripts/fetch_upstream.py
python3 scripts/stage_native.py
python3 scripts/build_qpkg.py
python3 scripts/verify_qpkg.py dist/MotrixServer_2.0.0.58_x86_64.qpkg
```

patchelf 不在 PATH 时，可以通过 `PATCHELF` 指定路径。下载缓存位于 `cache/`，
中间产物位于 `build/`，安装包和 SHA-256 文件位于 `dist/`。

## 安装与访问

在 App Center 使用手动安装，选择目标存储卷。安装包没有 QNAP 签名证书，
App Center 可能要求使用允许未签名安装包的手动安装选项。

默认使用 NAS 的 `admin` 账户及其主组运行（UID 0）；程序文件仍归 root 所有。
Web 端口为 **16880**，独立 MDXP 服务使用本机端口 **16881**，受管 aria2
默认使用本机 RPC 端口 **16800**。这些端口需要空闲。点击 App Center 图标
会在浏览器标签页中打开界面。

首次访问需要输入自动生成的 operator token。通过 SSH 读取：

```sh
MOTRIX_STATE=$(/sbin/getcfg MotrixServer Data_Dir -f /etc/config/qpkg.conf)
cat "$MOTRIX_STATE/operator-token"
```

令牌文件权限为 0600，不要公开其内容。网页使用 Motrix 自身鉴权；QTS 登录
不会自动解锁 Motrix。

## 目录与配置

默认任务数据保存在 `<安装卷>/.motrix-server`，位于程序目录之外。
下载保存在 Download 共享文件夹下的 `Motrix` 子目录。封装只为新增子目录
配置运行账户权限，不递归修改整个共享文件夹。管理员模式可直接使用已有共享目录；
只读文件系统和存储卷故障仍会阻止写入。

新增下载文件允许目标目录的共享组读写。任务数据目录仅允许服务账户和管理员
访问；operator 凭据继续使用明确的 0600 权限。

管理配置位于 `<Install_Path>/etc/motrix.conf`，普通原地升级通过 QDK 保留
已修改的配置。修改 `PORT`、`MDXP_PORT`、`DATA_DIR`、`DOWNLOAD_DIR`、
`PUBLIC_URL` 或 `HOST_LANGUAGE` 前先停止服务，修改后重新启动。
服务控制脚本会读取配置，因此该文件必须保持归 root 所有。

任务数据应放在同步写入正常的存储卷。应用和专用 aria2 都使用持久化 SQLite；
存储卷繁忙时，即使 CPU 和运行库兼容，也可能超过上游引擎的启动等待时间。
迁移安装卷时应明确迁移数据，或显式设置 `DATA_DIR`，避免打开另一套空配置。

```sh
MOTRIX_INSTALL=$(/sbin/getcfg MotrixServer Install_Path -f /etc/config/qpkg.conf)
"$MOTRIX_INSTALL/MotrixServer.sh" status
"$MOTRIX_INSTALL/MotrixServer.sh" stop
"$MOTRIX_INSTALL/MotrixServer.sh" start
```

服务等待 `/healthz` 确认应用及引擎就绪。停止时发送 SIGTERM，最多等待
120 秒完成持久化和引擎关闭。日志位于 `<Data_Dir>/logs/server.log`。

卸载保留任务数据、下载文件和服务账户，以维持文件归属。卸载前单独备份管理
配置；备份任务数据时先停止服务。

## 验证

`verify_qpkg.py` 检查压缩负载边界、gzip 完整性、root 文件归属、权限、必需
运行组件及逐文件 SHA-256。`smoke-runtime.mjs` 验证真实私有可执行文件、
预期运行身份、子进程、Worker 和 SQLite WAL 关闭后重新打开的持久化结果。
`tests/native-fixture.mjs` 提供本机 HTTP Range、BitTorrent tracker / peer
和 BEP 9 元数据测试源，无需依赖外部下载。

实机结果单独保存于忽略的 `evidence/` 目录。仓库和报告不应包含 SSH 密码或
operator token。

## 许可证

封装源码采用 MIT。安装包包含 Motrix 完整第三方声明、Node.js 许可证清单、
musl 版权声明，以及 GCC 许可证和运行库例外。QDK 安装脚本遵循其上游 GPL
许可，对应锁定源码可在 https://github.com/qnap-dev/QDK 获取。

## NAS 共享文件夹浏览修复（QPKG 2.0.0.53）

上游应用仍为 Motrix Server 2.0.0-beta.52；2.0.0.53 是 QNAP 打包修订版本。

打开网页的服务器文件夹选择器时，默认显示“NAS 共享文件夹”，从 QNAP 的 `/etc/config/smb.conf` 读取普通共享名称和路径。可双击共享、逐级浏览已有子目录、通过 NAS 面包屑或上一级返回共享列表，也支持输入 `/share/<共享名称>` 路径。侧边入口注明存储卷。Container、Browser Station、home/homes、回收站和快照等内部入口不展示。

浏览权限与写入权限分开：共享根只需可读、可进入，下载和新建目录时仍按配置运行账户的实际权限检查。当前只读目录会显示提示，禁止直接选作下载目标，但可继续浏览和进入可写子目录。不会修改现有共享及其子目录的权限，2.0.0.54 起按用户要求默认使用 admin 账户运行。

本机 Download、AWSGG、movie、game、movie1、Public、Multimedia 共享中的 Motrix 子目录可写；其余已有目录能否写入，以服务账户的真实权限为准。默认下载位置仍为 Download/Motrix。共享配置发生变更后，重启应用可刷新共享目录清单。

适配源码为 `patches/qnap-directories.mjs`，通过 `scripts/apply_qnap_browser.py` 的精确匹配补丁接入锁定的上游发布产物；不重新打包上游第三方依赖。脚本在 `stage_native.py` 中自动执行，匹配失败时停止构建。前端整个 JavaScript 模块图使用独立修订 URL，避免混用旧的缓存模块。目录导航、权限与目录逃逸测试可运行 `node --test tests/qnap-directories.test.mjs`。

管理员仍可通过程序目录 `etc/motrix.conf` 中的 `ALLOWED_SAVE_DIRS`（冒号分隔绝对路径）增加其他可写目录。NAS 共享浏览适配会另外加入真实可读共享；这些共享不要求根部可写。配置和目录偏好在原地升级时保留。

## 管理员默认运行（QPKG 2.0.0.54）

按本机用户要求，RUN_USER 默认改为 admin，RUN_GROUP 留空时使用账户主组 administrators。Node、aria2 及其子进程继承 UID 0，以便读写现有共享目录；不递归修改共享文件夹权限。已有安装升级时如保留了旧配置，需同步把 RUN_USER 改为 admin。任务数据库、下载路径和 operator token 保留。

管理员模式意味着下载服务及其插件拥有 NAS 管理员文件访问权限。Web 端仍要求 operator token。目录选择器继续只展示注册共享，且保留真实写入校验。只读目录提示会依据当前管理员账户权限更新。旧 motrixsvc 账户和历史文件归属保留，不清理用户文件。

## 记住登录（QPKG 2.0.0.58）

首次输入 operator token 后，当前浏览器通过 HttpOnly、SameSite=Strict Cookie 保持登录一年。会话的随机标识只在浏览器 Cookie 中，服务器在状态目录 operator-sessions.json 中持久化其 SHA-256 摘要和过期时间，文件权限 0600；应用重启不再丢失会话。不会把管理员令牌放入 localStorage，也不会取消认证。

主动退出会持久撤销当前会话；更换 operator token 后旧会话失效。浏览器清除 Cookie、使用无痕窗口、换设备或一年到期后仍需重新验证。请使用固定的 NAS 主机名或 IP 访问，不同主机名/IP 的浏览器 Cookie 彼此独立。

普通轮询请求的续期最多每十二小时写盘一次，避免每次刷新状态都产生同步磁盘写入。会话存储是应用数据的一部分，正常原地升级和重启保留。

## Fork 目录与自定义管理员令牌

构建命令在本 `qnap/` 目录执行。父仓库保留官方源码历史；发布输入继续由
`upstream.lock.json` 锁定。适配补丁针对指定版本，遇到不同产物会拒绝应用。

自定义令牌时，先停止服务，将令牌写入私有普通文件，再将 `etc/motrix.conf`
中的 `OPERATOR_TOKEN_FILE` 设置为该文件绝对路径。启动器将文件权限限制为
0600，通过上游支持的 `MOTRIX_OPERATOR_TOKEN` 接口传递。留空则使用上游
自动生成令牌的机制。不要将实际凭据提交到 Git。Motrix 令牌独立保存，
不会随 QTS admin 密码自动同步。

浏览器成功登录后有效期为一年，服务重启后继续有效。主动退出、清除浏览器
数据、会话过期或更换令牌后需要重新登录。会话文件仅保存 Cookie 的哈希。

DHT 引导地址覆盖属于可选 NAS 配置。本适配不修改路由器或代理配置，
也不保证下载速度提升。

HTTP 的 NAS 页面包含复制兼容处理，支持浏览器未提供安全上下文剪贴板接口的情况。复制仍由用户点击触发；浏览器拒绝时会显示失败。升级时，如果 QDK 因默认配置变化而将用户配置移到备份文件，安装钩子会恢复本次升级保存的配置。
