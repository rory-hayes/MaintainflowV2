import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const layoutSource = readFileSync("src/app/layout.tsx", "utf8")
const socialImageSource = readFileSync("src/app/opengraph-image.tsx", "utf8")

test("homepage exposes explicit evidence-safe social metadata", () => {
  assert.match(layoutSource, /openGraph: \{/)
  assert.match(layoutSource, /twitter: \{/)
  assert.match(layoutSource, /card: "summary_large_image"/)
  assert.match(layoutSource, /Business Evals for Critical Customer Journeys/)
  assert.match(layoutSource, /Deterministic, reviewable evidence that approved Lead form and Trial signup journeys/)
  assert.doesNotMatch(layoutSource, /Client Journey Assurance|automation agencies|workflow maintenance/)
})

test("social card matches the bounded Business Evals promise without fabricated traction", () => {
  assert.match(socialImageSource, /width: 1200, height: 630/)
  assert.match(socialImageSource, /Continuously prove your critical customer journeys still work/)
  assert.match(socialImageSource, /From the first page to the final business outcome/)
  assert.match(socialImageSource, /Business Evals/)
  assert.match(socialImageSource, /DETERMINISTIC VERDICTS/)
  for (const stage of ["Open page", "Fill synthetic data", "Submit once", "Prove outcome", "Clean up"]) {
    assert.match(socialImageSource, new RegExp(stage))
  }
  assert.doesNotMatch(socialImageSource, /Client Journey Assurance|automation agencies|1 client \/ 3 workflows|No sales call/)
  assert.doesNotMatch(socialImageSource, /EUR 1,500|paid pilot|Human-reviewed/)
  assert.doesNotMatch(socialImageSource, /18 active clients|64 production workflows|1,284|98\.7%/)
})
