import {
  defineSourceControlDriver,
  withOwnServices,
} from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";
import { definition } from "../shared/definition.ts";
import * as DepotCli from "./DepotCli.ts";
import * as DepotPullRequestProvider from "./DepotPullRequestProvider.ts";
import * as DepotSourceControlProvider from "./DepotSourceControlProvider.ts";

export const driver = defineSourceControlDriver({
  kind: definition.kind,
  definition,
  make: withOwnServices(
    Effect.all({
      sourceControl: DepotSourceControlProvider.make,
      discovery: Effect.succeed(DepotSourceControlProvider.discovery),
      pullRequests: DepotPullRequestProvider.make,
    }),
    DepotCli.layer,
  ),
});
