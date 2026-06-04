import type { ReactNode } from 'react'

type CardProps = {
  id?: string
  no?: string
  title?: ReactNode
  tag?: ReactNode
  className?: string
  children: ReactNode
}

// Glas-kort fra Claude Design-handoff. `.card` + `.card-head`/`.sect`-struktur.
// `id` styrer grid-area i bento-gridet (#operator, #finans, #opgaver, ...).
export function Card({ id, no, title, tag, className = '', children }: CardProps) {
  return (
    <section className={`card ${className}`.trim()} id={id}>
      {(no || title || tag) && (
        <div className="card-head">
          <div className="sect">
            {no && <span className="no">{no}</span>}
            {title && <span className="ttl">{title}</span>}
          </div>
          {tag}
        </div>
      )}
      {children}
    </section>
  )
}
