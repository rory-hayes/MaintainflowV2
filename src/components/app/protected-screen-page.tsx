import { MaintainFlowAppShell } from "@/components/app/maintainflow-app-shell"
import { MaintainFlowScreen } from "@/components/app/maintainflow-screen"
import type { ScreenKey } from "@/data/maintainflow"
import { Suspense } from "react"

export function ProtectedScreenPage({
  screenKey,
  entityId,
}: {
  screenKey: ScreenKey
  entityId?: string
}) {
  return (
    <MaintainFlowAppShell>
      <Suspense fallback={null}>
        <MaintainFlowScreen screenKey={screenKey} entityId={entityId} />
      </Suspense>
    </MaintainFlowAppShell>
  )
}
