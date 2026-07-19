import { cn } from "@/lib/utils"
import { IconActivityHeartbeat } from "@tabler/icons-react"

type BrandMarkProps = {
  className?: string
  compact?: boolean
  descriptor?: string
}

export function BrandMark({ className, compact = false, descriptor }: BrandMarkProps) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <span className="flex size-9 items-center justify-center text-primary">
        <IconActivityHeartbeat aria-hidden className="size-8 stroke-[2.25]" />
      </span>
      {!compact && (
        <span className="flex flex-col leading-none">
          <span className="text-lg font-semibold tracking-[-0.025em] text-foreground">
            Maintain Flow
          </span>
          {descriptor ? <span className="mt-1 text-xs font-medium text-muted-foreground">{descriptor}</span> : null}
        </span>
      )}
    </span>
  )
}
