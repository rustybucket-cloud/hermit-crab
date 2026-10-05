import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { useMemo } from 'react'

export function Preview({ markdown }: { markdown: string }) {
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(markdown, { async: false, gfm: true })),
    [markdown]
  )
  return (
    <div className="preview-scroller">
      <article className="preview" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}
