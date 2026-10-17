// Mac 測試版沒有 Apple 開發者憑證：打包後用「臨時簽章」（ad-hoc）重新簽一次。
// Apple 晶片的 Mac 不執行完全沒有簽章的程式；打包時改過檔案，Electron 原本的簽章會失效。
// 同學第一次打開仍要到「系統設定 → 隱私權與安全性」按「強制打開」。
const { execFileSync } = require('node:child_process')
const path = require('node:path')

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
}
