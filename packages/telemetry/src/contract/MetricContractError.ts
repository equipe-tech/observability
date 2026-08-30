export type MetricMeasurementErrorCode =
  | "OBS_METRIC_UNKNOWN_ALIAS"
  | "OBS_METRIC_KIND_MISMATCH"
  | "OBS_METRIC_UNDECLARED_ATTRIBUTE"
  | "OBS_METRIC_MISSING_ATTRIBUTE"
  | "OBS_METRIC_VALUE_NOT_ALLOWED"
  | "OBS_METRIC_CARDINALITY_EXCEEDED"
  | "OBS_METRIC_INVALID_VALUE";

type InvalidMetricMeasurementOptions = {
  readonly code: MetricMeasurementErrorCode;
  readonly operation: string;
  readonly message: string;
  readonly metricAlias: string;
  readonly metricName?: string;
  readonly attributeName?: string;
};

export class InvalidMetricMeasurement extends Error {
  readonly code: MetricMeasurementErrorCode;
  readonly operation: string;
  readonly metricAlias: string;
  readonly metricName?: string;
  readonly attributeName?: string;
  readonly retryable = false;

  constructor(options: InvalidMetricMeasurementOptions) {
    super(options.message);
    this.name = "InvalidMetricMeasurement";
    this.code = options.code;
    this.operation = options.operation;
    this.metricAlias = options.metricAlias;
    if (options.metricName !== undefined) this.metricName = options.metricName;
    if (options.attributeName !== undefined) this.attributeName = options.attributeName;
  }
}
