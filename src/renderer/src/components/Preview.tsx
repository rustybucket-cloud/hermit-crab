import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { useMemo } from 'react'
import { fountainToHtml } from '../../../shared/fountain'
import type { ContentFormat } from '../../../shared/types'

export function Preview({ text, format }: { text: string; format: ContentFormat }) {
  const html = useMemo(
    () =>
      DOMPurify.sanitize(format === 'fountain' ? fountainToHtml(text) : marked.parse(text, { async: false, gfm: true })),
    [text, format]
  )
  return (
    <div className="preview-scroller">
      <article
        className={`preview${format === 'fountain' ? ' screenplay' : ''}`}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  )
}
