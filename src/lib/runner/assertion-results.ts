import { sha256 } from "@noble/hashes/sha256"
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils"

import type { RunnerAssertionResult, RunnerStageVerdict } from "@/lib/runner/types"

export const DETERMINISTIC_EVALUATOR_VERSION = "maintain-flow-business-evals-v1"

export function createRunnerAssertionResult(input: {
  assertionId: string
  required: boolean
  expectedRule: string
  safeObservation: string
  result: RunnerStageVerdict
  evaluatedAt: string
}): RunnerAssertionResult {
  const safeObservation = input.safeObservation.slice(0, 1_000)
  return {
    assertionId: input.assertionId.slice(0, 160),
    required: input.required,
    expectedRule: input.expectedRule.slice(0, 1_000),
    safeObservation,
    observationDigest: sha256Hex(safeObservation),
    result: input.result,
    evaluatedAt: new Date(input.evaluatedAt).toISOString(),
    evaluatorVersion: DETERMINISTIC_EVALUATOR_VERSION,
  }
}

export function assertRequiredAssertionResultsAlign(
  stageVerdict: RunnerStageVerdict,
  assertions: RunnerAssertionResult[]
) {
  const required = assertions.filter((assertion) => assertion.required)
  if (!required.length) throw new Error("Every eval stage requires a deterministic assertion record.")
  for (const assertion of assertions) {
    const expectedDigest = sha256Hex(assertion.safeObservation)
    if (
      !assertion.assertionId
      || !assertion.expectedRule
      || assertion.observationDigest !== expectedDigest
      || assertion.evaluatorVersion !== DETERMINISTIC_EVALUATOR_VERSION
      || !Number.isFinite(Date.parse(assertion.evaluatedAt))
    ) {
      throw new Error("An eval stage contains an invalid deterministic assertion record.")
    }
    if (assertion.required && assertion.result !== stageVerdict) {
      throw new Error("A required deterministic assertion result does not match its stage verdict.")
    }
  }
}

export function reclassifyRunnerAssertionResults(
  assertions: RunnerAssertionResult[],
  result: RunnerStageVerdict
): RunnerAssertionResult[] {
  return assertions.map((assertion) => ({ ...assertion, result }))
}

function sha256Hex(value: string) {
  return bytesToHex(sha256(utf8ToBytes(value)))
}
