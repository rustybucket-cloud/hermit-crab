import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { useMemo } from 'react'
import { fountainToHtml } from '../../../shared/fountain'
import type { ContentFormat } from '../../../shared/types'

export const renderMarkdown = (markdown: string) =>
  DOMPurify.sanitize(marked.parse(markdown, { async: false, gfm: true }))

export function Preview({ text, format }: { text: string; format: ContentFormat }) {
  const html = useMemo(
    () => (format === 'fountain' ? DOMPurify.sanitize(fountainToHtml(text)) : renderMarkdown(text)),
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
