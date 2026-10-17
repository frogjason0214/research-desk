import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

// 用 Mozilla pdf.js 抽出每一頁的文字。行與行之間距離特別大時視為段落，插入空行，方便之後切段落。

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

interface TextItem {
  str: string
  hasEOL: boolean
  transform: number[]
  height: number
}

export async function extractPdfText(data: ArrayBuffer): Promise<string[]> {
  // pdf.js 會把 ArrayBuffer 轉交給 worker，用副本避免原本的資料被清空
  const doc = await pdfjs.getDocument({ data: new Uint8Array(data.slice(0)) }).promise
  const pages: string[] = []
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      let out = ''
      let lastY: number | null = null
      let lineHeight = 0
      for (const raw of content.items) {
        if (!('str' in raw)) continue
        const item = raw as TextItem
        const y = item.transform[5]
        if (lastY !== null && lineHeight > 0 && Math.abs(lastY - y) > lineHeight * 1.8 && !out.endsWith('\n\n')) {
          out = out.replace(/[ \n]*$/, '\n\n')
        }
        out += item.str
        out += item.hasEOL ? '\n' : ''
        if (item.str.trim()) {
          lastY = y
          lineHeight = item.height || lineHeight
        }
      }
      pages.push(out.replace(/[ \t]+\n/g, '\n').trim())
      page.cleanup()
    }
  } finally {
    await doc.destroy()
  }
  return pages
}
