import { STUDY_TYPES, type Author, type Bib } from '../../shared/types'
import type { Gemini, Part } from '../ai/gemini'

// 送給 Gemini 的兩種任務：判讀書目、預填心理學欄位。只送必要的前段內容。

const BIB_CHARS = 5000
const FIELD_CHARS = 16000
const MAX_INLINE_PDF = 15 * 1024 * 1024

type Source = { text: string } | { pdf: Buffer }

function parts(src: Source, chars: number, instruction: string): Part[] {
  if ('text' in src) return [{ text: `${instruction}\n\n----- 文獻內容 -----\n${src.text.slice(0, chars)}` }]
  if (src.pdf.length > MAX_INLINE_PDF) throw new Error('PDF 太大，無法送給 AI 判讀（上限 15 MB）。')
  return [{ inline_data: { mime_type: 'application/pdf', data: src.pdf.toString('base64') } }, { text: instruction }]
}

export async function aiBibliography(gemini: Gemini, src: Source): Promise<Partial<Bib>> {
  const result = await gemini.json<{
    title: string
    authors: Author[]
    year: string
    journal: string
    volume: string
    issue: string
    pages: string
    doi: string
  }>(
    parts(src, BIB_CHARS, '請從這篇文獻的首頁判讀書目資料。'),
    {
      type: 'OBJECT',
      properties: {
        title: { type: 'STRING', description: '篇名（原文，不翻譯）' },
        authors: {
          type: 'ARRAY',
          description: '作者，依出現順序',
          items: {
            type: 'OBJECT',
            properties: {
              family: { type: 'STRING', description: '姓。中文姓名例如「王小明」填「王」' },
              given: { type: 'STRING', description: '名。中文姓名例如「王小明」填「小明」；英文填全名或縮寫' }
            },
            required: ['family', 'given']
          }
        },
        year: { type: 'STRING', description: '出版年（西元，四位數）' },
        journal: { type: 'STRING', description: '期刊名稱（原文）' },
        volume: { type: 'STRING' },
        issue: { type: 'STRING' },
        pages: { type: 'STRING', description: '起訖頁，例如 45-67' },
        doi: { type: 'STRING' }
      },
      required: ['title', 'authors', 'year', 'journal', 'volume', 'issue', 'pages', 'doi']
    },
    '你是書目資料擷取助手。只根據提供的內容填寫，看不出來的欄位一律留空字串，不要猜測或補完。民國年請換算成西元年。'
  )
  return { ...result, authors: (result.authors ?? []).filter((a) => a.family || a.given) }
}

export interface PsychFields {
  study_type: string
  sample: string
  measures: string
  findings: string
}

export async function aiPsychFields(gemini: Gemini, src: Source): Promise<PsychFields> {
  return gemini.json<PsychFields>(
    parts(src, FIELD_CHARS, '請閱讀這篇心理學文獻，整理以下欄位。'),
    {
      type: 'OBJECT',
      properties: {
        study_type: { type: 'STRING', description: `研究類型，從這些選一個：${STUDY_TYPES.join('、')}` },
        sample: { type: 'STRING', description: '樣本數與對象，例如「N = 312，台灣大學生（女性 58%）」' },
        measures: { type: 'STRING', description: '使用的量表或測量工具，量表名稱保留原文，多個以「；」分隔' },
        findings: { type: 'STRING', description: '主要發現，2～4 句' }
      },
      required: ['study_type', 'sample', 'measures', 'findings']
    },
    '你是心理學研究助理。只根據提供的內容填寫，使用繁體中文（台灣用語）；量表、專有名詞保留原文。內容裡看不出來的欄位留空字串，不要猜測。'
  )
}
