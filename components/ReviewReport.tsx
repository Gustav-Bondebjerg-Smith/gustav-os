// Lille markdown-renderer til review-rapporten. Inputformatet er KONTROLLERET af
// prompten i lib/weekly-review.ts (## overskrifter, - bullets, **fed**), så vi
// slipper for en markdown-dependency. Server-komponent (ren funktion), genbrugt
// til både seneste review og arkivet. Renderer kun den delmængde af markdown vi
// selv beder Sonnet om.
import { Fragment, type ReactNode } from 'react'

function inline(text: string): ReactNode {
  // **fed** -> <strong>. Ulige split-indeks er det der stod mellem stjernerne.
  return text.split('**').map((part, i) =>
    i % 2 === 1 ? <strong key={i}>{part}</strong> : <Fragment key={i}>{part}</Fragment>,
  )
}

export function ReviewReport({ report }: { report: string }) {
  const blocks: ReactNode[] = []
  let items: string[] = []
  let ordered = false

  const flush = () => {
    if (!items.length) return
    const list = items
    const Tag = ordered ? 'ol' : 'ul'
    blocks.push(
      <Tag key={`l-${blocks.length}`}>
        {list.map((b, i) => (
          <li key={i}>{inline(b)}</li>
        ))}
      </Tag>,
    )
    items = []
  }

  for (const raw of report.split('\n')) {
    const t = raw.trim()
    if (!t) {
      flush()
      continue
    }
    if (/^#{1,6}\s/.test(t)) {
      flush()
      blocks.push(
        <h3 key={`h-${blocks.length}`} className="rr-h">
          {inline(t.replace(/^#{1,6}\s/, ''))}
        </h3>,
      )
    } else if (/^[-*]\s/.test(t)) {
      if (ordered) flush() // skift fra ordered til unordered
      ordered = false
      items.push(t.replace(/^[-*]\s/, ''))
    } else if (/^\d+\.\s/.test(t)) {
      if (!ordered) flush() // skift fra unordered til ordered
      ordered = true
      items.push(t.replace(/^\d+\.\s/, ''))
    } else {
      flush()
      blocks.push(<p key={`p-${blocks.length}`}>{inline(t)}</p>)
    }
  }
  flush()

  return <div className="review-report">{blocks}</div>
}
