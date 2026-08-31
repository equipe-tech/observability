export const malformedSourceMapErrors = (upload) =>
  [
    null,
    [],
    {},
    { organization: "org", project: "web", release: "1", includePaths: "dist" },
    { organization: "org", project: "web", release: "1", includePaths: [null] },
    {
      organization: "org",
      project: "web",
      release: "1",
      includePaths: ["dist"],
      authToken: "secret",
    },
    {
      organization: "org",
      project: "web",
      release: "1",
      includePaths: ["dist"],
      deleteAfterUpload: "yes",
    },
  ].map((input) => {
    try {
      upload(input);
      return "missing-error";
    } catch (error) {
      return error?.code ?? error?.constructor?.name ?? "unknown";
    }
  });
