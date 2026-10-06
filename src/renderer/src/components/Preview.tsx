import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { useMemo } from 'react'

export const renderMarkdown = (markdown: string) =>
  DOMPurify.sanitize(marked.parse(markdown, { async: false, gfm: true }))

export function Preview({ markdown }: { markdown: string }) {
  const html = useMemo(() => renderMarkdown(markdown), [markdown])
  return (
    <div className="preview-scroller">
      <article className="preview" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}
