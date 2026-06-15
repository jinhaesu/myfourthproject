import { ReactNode } from 'react'

interface EmptyStateProps {
  icon?: ReactNode
  title: string
  description?: string
  action?: ReactNode
  shortcut?: string
}

export default function EmptyState({ icon, title, description, action, shortcut }: EmptyStateProps) {
  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="text-center max-w-sm">
        {icon && (
          <div className="mx-auto w-12 h-12 rounded-full bg-ink-100 flex items-center justify-center text-ink-400 mb-4">
            {icon}
          </div>
        )}
        <h3 className="text-sm font-semibold text-ink-900">{title}</h3>
        {description && <p className="mt-1.5 text-xs text-ink-500 leading-relaxed">{description}</p>}
        {action && <div className="mt-4">{action}</div>}
        {shortcut && (
          <div className="mt-3 inline-flex items-center gap-1 text-2xs text-ink-400">
            <kbd className="px-1.5 py-0.5 rounded border border-ink-200 bg-white font-mono text-2xs">
              {shortcut}
            </kbd>
            <span>로 빠른 이동</span>
          </div>
        )}
      </div>
    </div>
  )
}
