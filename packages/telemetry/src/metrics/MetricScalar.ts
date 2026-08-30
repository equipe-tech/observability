import { Predicate, Schema } from "effect";
import type { MetricAttributeValue } from "../Metrics.ts";

const metricScalarSchema = Schema.Union([Schema.String, Schema.Number, Schema.Boolean]);

export const isMetricScalar = Schema.is(metricScalarSchema);

export const isFiniteMetricScalar = (value: MetricAttributeValue): boolean =>
  isMetricScalar(value) && (!Predicate.isNumber(value) || Number.isFinite(value));

export const metricScalarIdentity = (value: MetricAttributeValue): string =>
  `${Predicate.isString(value) ? "string" : Predicate.isNumber(value) ? "number" : "boolean"}:${String(value)}`;
