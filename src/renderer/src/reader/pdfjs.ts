import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

// pdf.js 的共用設定。中文 PDF 常用沒有內嵌的字元對照表（CMap），標準字型也可能沒有內嵌；
// 兩者都打包進程式（vite 把每個檔案變成一個網址），不需要連網。

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

const cmaps = import.meta.glob('../../../../node_modules/pdfjs-dist/cmaps/*.bcmap', { query: '?url', import: 'default', eager: true }) as Record<string, string>
const fonts = import.meta.glob('../../../../node_modules/pdfjs-dist/standard_fonts/*', { query: '?url', import: 'default', eager: true }) as Record<string, string>

const byName = (files: Record<string, string>): Map<string, string> =>
  new Map(Object.entries(files).map(([p, url]) => [p.slice(p.lastIndexOf('/') + 1), url]))
const cmapUrls = byName(cmaps)
const fontUrls = byName(fonts)

async function fetchBytes(url: string | undefined, what: string): Promise<Uint8Array> {
  if (!url) throw new Error(`找不到 ${what}`)
  const res = await fetch(url)
  return new Uint8Array(await res.arrayBuffer())
}

class CMapFactory {
  async fetch({ name }: { name: string }): Promise<{ cMapData: Uint8Array; isCompressed: boolean }> {
    return { cMapData: await fetchBytes(cmapUrls.get(`${name}.bcmap`), `CMap ${name}`), isCompressed: true }
  }
}

class FontFactory {
  async fetch({ filename }: { filename: string }): Promise<Uint8Array> {
    return fetchBytes(fontUrls.get(filename), `字型 ${filename}`)
  }
}

/** 開啟 PDF（會複製一份資料，原本的陣列不會被轉交給 worker 而清空） */
export function openPdf(data: Uint8Array | ArrayBuffer): pdfjs.PDFDocumentLoadingTask {
  const bytes = data instanceof Uint8Array ? data.slice() : new Uint8Array(data.slice(0))
  return pdfjs.getDocument({
    data: bytes,
    CMapReaderFactory: CMapFactory as never,
    StandardFontDataFactory: FontFactory as never,
    useWorkerFetch: false,
    // 程式的安全設定不允許 eval
    isEvalSupported: false
  })
}

export { pdfjs }
