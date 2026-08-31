export const malformedCaptureErrors = (reporter) =>
  [
    null,
    [],
    {},
    { envelope: null },
    { envelope: [] },
    {
      envelope: {
        errorType: "UnexpectedDefect",
        errorMessage: "bad",
        stack: null,
        fingerprint: null,
        tags: null,
        context: null,
        correlation: null,
      },
    },
  ].map((input) => {
    try {
      reporter.capture(input);
      return "missing-error";
    } catch (error) {
      return error?.code ?? error?.constructor?.name ?? "unknown";
    }
  });
