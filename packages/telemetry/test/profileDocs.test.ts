import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vite-plus/test";

const profilesDocumentation = await readFile(
  new URL("../../../docs/profiles.md", import.meta.url),
  "utf8",
);

describe("observability profile documentation", () => {
  it("states the complete nested Node shutdown budget", () => {
    expect(profilesDocumentation).toContain(
      "3950 ms para o trabalho normal de `close`, até 500 ms para a limpeza forçada de adapters que excederam seu prazo, até 500 ms para o descarte do runtime e 50 ms de margem para o scheduler",
    );
  });

  it("requires interruption-safe idempotent close for the bounded retry", () => {
    expect(profilesDocumentation).toContain(
      "faz uma única nova tentativa com o orçamento limitado de limpeza forçada",
    );
    expect(profilesDocumentation).toContain(
      "implementações de `ObservabilityAdapterHandle.close` devem tolerar interrupção e ser idempotentes",
    );
  });

  it("states when forcedCleanup is present in serialized reports", () => {
    expect(profilesDocumentation).toContain(
      "O campo JSON opcional `forcedCleanup` aparece somente no resultado `deadline-exceeded` de um adapter que recebeu a tentativa forçada",
    );
  });
});
