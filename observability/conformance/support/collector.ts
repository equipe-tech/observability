import {
  startLocalCollectorDestination,
  type LocalCollectorDestination,
} from "@equipe-tech/observability/testing";
import { fixtureError } from "./FixtureError.ts";

export type LocalCollector = LocalCollectorDestination;

export const startLocalCollector = async (): Promise<LocalCollector> =>
  startLocalCollectorDestination().catch((cause) => {
    throw fixtureError(String(cause));
  });
