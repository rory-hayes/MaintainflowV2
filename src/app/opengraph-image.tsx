import { ImageResponse } from "next/og"

export const alt = "Maintain Flow Business Evals for critical customer journeys"
export const size = { width: 1200, height: 630 }
export const contentType = "image/png"

const stages = ["Open page", "Fill synthetic data", "Submit once", "Prove outcome", "Clean up"]

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#ffffff",
          color: "#0f172a",
          padding: "54px 62px",
          fontFamily: "Arial, sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
            <div
              style={{
                width: 48,
                height: 48,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                borderRadius: 12,
                background: "#2563eb",
                color: "#ffffff",
                fontSize: 25,
                fontWeight: 700,
              }}
            >
              M
            </div>
            <div style={{ display: "flex", flexDirection: "column" }}>
              <div style={{ fontSize: 28, fontWeight: 700, letterSpacing: -0.6 }}>Maintain Flow</div>
              <div style={{ marginTop: 2, fontSize: 17, color: "#64748b" }}>Business Evals</div>
            </div>
          </div>
          <div
            style={{
              display: "flex",
              border: "1px solid #bfdbfe",
              borderRadius: 999,
              background: "#eff6ff",
              color: "#1d4ed8",
              padding: "9px 16px",
              fontSize: 15,
              fontWeight: 700,
            }}
          >
            DETERMINISTIC VERDICTS
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", maxWidth: 1020 }}>
          <div style={{ fontSize: 60, lineHeight: 1.06, fontWeight: 700, letterSpacing: -2.4 }}>
            Continuously prove your critical customer journeys still work.
          </div>
          <div style={{ marginTop: 22, fontSize: 23, lineHeight: 1.38, color: "#475569" }}>
            From the first page to the final business outcome—with reviewable evidence at every stage.
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {stages.map((stage, index) => (
            <div key={stage} style={{ display: "flex", alignItems: "center", flex: 1, gap: 8 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  border: "1px solid #e2e8f0",
                  background: "#f8fafc",
                  padding: "10px 12px",
                  color: "#334155",
                  fontSize: 14,
                  fontWeight: 600,
                  whiteSpace: "nowrap",
                }}
              >
                <div
                  style={{
                    width: 20,
                    height: 20,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: 999,
                    background: "#dbeafe",
                    color: "#1d4ed8",
                    fontSize: 11,
                    fontWeight: 700,
                  }}
                >
                  {index + 1}
                </div>
                {stage}
              </div>
              {index < stages.length - 1 ? <div style={{ display: "flex", color: "#94a3b8" }}>→</div> : null}
            </div>
          ))}
        </div>
      </div>
    ),
    size
  )
}
