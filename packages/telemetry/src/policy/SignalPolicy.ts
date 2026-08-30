import type { WideEventFields } from "../WideEvent.ts";
import type { DataPolicy, PolicySurface } from "./DataPolicy.ts";
import { transformSignalFields, type PolicyDecision } from "./PolicyTransform.ts";

export const sanitizeSignalFields = (
  policy: DataPolicy,
  surface: PolicySurface,
  fields: WideEventFields,
): PolicyDecision<WideEventFields> => transformSignalFields(policy, surface, fields);
