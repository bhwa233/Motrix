#!/usr/bin/env python3
"""Apply a narrow, version-pinned QNAP adapter to the official release bundles.

No dependencies are rebundled. Exact single-match assertions fail closed if the
upstream release changes. All renderer JS URLs get a new revision to avoid stale
module graphs in already-open browsers.
"""
import hashlib
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def replace_once(text, old, new):
    if text.count(old) != 1:
        raise RuntimeError(f'Pinned upstream patch did not match exactly once: {old[:100]}')
    return text.replace(old, new)

def apply(app):
    server = app / 'dist/server/index.mjs'
    original = server.read_text()
    if hashlib.sha256(original.encode()).hexdigest() != 'c73bf85985d8c9cf172791061e19255e860898d49ea3f1140f2e951a813656b2':
        raise RuntimeError('Unexpected upstream server bundle digest')
    if "./qnap-directories.mjs" in original:
        raise RuntimeError('Apply only to a clean upstream bundle')
    text = 'import { configureQnapPolicy, wrapDirectoryService } from "./qnap-directories.mjs";\n' + original
    text = replace_once(text,
        'allowedSaveDirsValue:process.env.MOTRIX_ALLOWED_SAVE_DIRS});if(T&&',
        'allowedSaveDirsValue:process.env.MOTRIX_ALLOWED_SAVE_DIRS});const qnapShares=await configureQnapPolicy(ne);if(T&&')
    text = replace_once(text, 'ht=new ServerDirectoryService(ne),',
        'ht=wrapDirectoryService(new ServerDirectoryService(ne),qnapShares),')
    text = 'import { createPersistentOperatorSessions } from "./persistent-operator-sessions.mjs";\n' + text
    text = replace_once(text, 'var fy=`mtx_op`,py=6048e5,my=6e4,hy=20',
        'var fy=`mtx_op`,py=31536e6,my=6e4,hy=20')
    text = replace_once(text, 'r=configuredPublicOrigin(t.publicUrl),i=new Map,a=new Map,revoke=',
        'r=configuredPublicOrigin(t.publicUrl),i=createPersistentOperatorSessions(t.operatorToken,{now:n}),a=new Map,revoke=')
    shutil.copy2(ROOT / 'patches/persistent-operator-sessions.mjs', server.with_name('persistent-operator-sessions.mjs'))
    server.write_text(text)
    shutil.copy2(ROOT / 'patches/qnap-directories.mjs', server.with_name('qnap-directories.mjs'))

    web = app / 'dist/renderer-web'
    bundle = web / 'assets/app-root-D8tYHJn5.js'
    text = bundle.read_text()
    share_pattern = r'/^\/share\/(?:CACHEDEV\d+_DATA|MD\d+_DATA|HD[A-Z]_DATA)\/[^/]+$/'
    text = replace_once(text,
        '[this.defaultPath,t.defaultPath,...t.paths.map(e=>e.path)]',
        '[!this.file&&t.paths.some(e=>'+share_pattern+'.test(e.path))?`/share`:this.defaultPath,t.defaultPath,...t.paths.map(e=>e.path)]')
    text = replace_once(text,
        'name:n(`directoryPicker.places.${e.kind}`)',
        'name:e.kind===`root`&&e.path===`/share`?`NAS 共享文件夹`:n(`directoryPicker.places.${e.kind}`)')
    text = replace_once(text,
        '.map(e=>({path:e.path,name:e.path}))},{id:`favorites`',
        '.map(e=>({path:e.path,name:'+share_pattern+'.test(e.path)?e.path.split(`/`).pop()+` · `+e.path.split(`/`)[2].replace(`CACHEDEV`,`卷`).replace(`_DATA`,``):e.path}))},{id:`favorites`')
    text = replace_once(text,
        'size:`sm`,disabled:y||!x,onClick:()=>void t.confirm()',
        'size:`sm`,disabled:y||!x||(!e.file&&!r.selected&&r.listing?.canCreate===!1),onClick:()=>void t.confirm()')
    anchor = '(0,Z.jsxs)(`div`,{"data-testid":`directory-picker-actions`'
    notice = '(!e.file&&!r.selected&&r.listing?.canCreate===!1)&&(0,Z.jsx)(`p`,{role:`status`,"data-testid":`qnap-directory-permission`,className:`px-3 py-2 text-xs text-muted-foreground`,children:r.listing.path===`/share`?`请选择共享文件夹，双击进入后可继续浏览子目录。`:`当前目录无写入权限，可以继续浏览或进入可写的子目录。`}),'
    text = replace_once(text, anchor, notice + anchor)
    bundle.write_text(text)

    login = web / 'assets/index-C06y9nm5.js'
    login_text = login.read_text()
    login_text = replace_once(login_text,
        '此服务器需要管理员令牌。请在主机上设置 MOTRIX_OPERATOR_TOKEN，或读取 <dataDir>/operator-token 中的令牌，然后粘贴到下方。',
        '首次使用请输入管理员令牌。验证成功后，此浏览器会记住登录一年，应用或 NAS 重启后仍然有效。主动退出或清除浏览器数据后需要重新验证。令牌可从主机的 <dataDir>/operator-token 读取。')
    login.write_text(login_text)

    # Rename the entire JS module graph, not only its entry point. Cached lazy
    # chunks must not import a second, stale copy of the old application root.
    scripts = list(web.rglob('*.js'))
    mapping = {item.name: item.stem + '-qnap-nas5.js' for item in scripts}
    for item in scripts + list(web.rglob('*.html')):
        text = item.read_text()
        for old, new in mapping.items():
            text = text.replace(old, new)
        item.write_text(text)
    for item in scripts:
        item.rename(item.with_name(mapping[item.name]))
    # A synchronous script installs HTTP clipboard support before deferred modules run.
    clipboard_name = 'qnap-clipboard-v1.js'
    shutil.copy2(ROOT / 'patches/clipboard-fallback.js', web / 'assets' / clipboard_name)
    index = web / 'index.html'
    index.write_text(replace_once(index.read_text(), '</head>',
        f'<script src="./assets/{clipboard_name}"></script>\n  </head>'))
    return {'serverInputSha256': hashlib.sha256(original.encode()).hexdigest(), 'rendererRevision': 'qnap-nas5'}

if __name__ == '__main__':
    import json
    print(json.dumps(apply(Path(sys.argv[1])), indent=2))
