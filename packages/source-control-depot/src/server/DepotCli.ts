import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { VcsProcessSpawnError, VcsProcessExitError } from "@t3tools/contracts";
import {
  PullRequestProviderError,
  type ProviderRepositoryRef,
} from "@t3tools/source-control-core/server/PullRequestProvider";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import { definition } from "../shared/definition.ts";

export class DepotCli extends Context.Service<
  DepotCli,
  {
    readonly run: <S extends Schema.Top>(
      input: {
        readonly cwd: string;
        readonly operation: string;
        readonly args: ReadonlyArray<string>;
        readonly stdin?: string;
      },
      schema: S,
    ) => Effect.Effect<S["Type"], PullRequestProviderError, S["DecodingServices"]>;
    readonly scope: (
      input: ProviderRepositoryRef,
    ) => Effect.Effect<
      { readonly org: string; readonly args: ReadonlyArray<string> },
      PullRequestProviderError
    >;
    readonly organization: (
      cwd: string,
      remoteUrl?: string,
    ) => Effect.Effect<string, PullRequestProviderError>;
  }
>()("@t3tools/source-control-depot/server/DepotCli") {}

export const failure = (operation: string, detail: string) =>
  new PullRequestProviderError({
    provider: definition.kind,
    operation,
    reason: "failed",
    detail,
  });

const isSpawnError = Schema.is(VcsProcessSpawnError);
const isExitError = Schema.is(VcsProcessExitError);

const make = Effect.gen(function* () {
  const { process } = yield* SourceControlHost.SourceControlHost;
  const execute = Effect.fn("DepotCli.execute")(function* (input: {
    readonly cwd: string;
    readonly operation: string;
    readonly args: ReadonlyArray<string>;
    readonly stdin?: string;
  }) {
    let mergeFailure: string | undefined;
    return yield* process
      .run({
        ...input,
        command: "depot",
        timeoutMs: 30_000,
        maxOutputBytes: ["diff", "file"].includes(input.operation) ? 32_000_000 : 4_000_000,
        concurrency: { key: "depot", limit: 4 },
        classifyFailure: (stderr) => {
          if (
            input.operation === "viewer" &&
            /unknown (?:flag|command)|does not support viewer identity|unimplemented/iu.test(stderr)
          )
            mergeFailure = "Viewer identity requires an updated Depot CLI and API.";
          if (
            ["repository", "checkout"].includes(input.operation) &&
            /unknown (?:flag|command)/iu.test(stderr)
          )
            mergeFailure =
              "Upgrade the Depot CLI on this environment to a version with repository lookup and MR checkout.";
          if (input.operation === "checkout") {
            if (/commit or stash local changes/iu.test(stderr))
              mergeFailure =
                "Commit or stash local changes before checking out this merge request.";
            else if (/local branch has commits/iu.test(stderr))
              mergeFailure =
                "The local branch contains additional commits. Preserve them before checking out this merge request.";
            else if (/use --detach/iu.test(stderr))
              mergeFailure =
                "This merge request is closed, merged or its branch was deleted. Use depot mr checkout --detach to inspect its recorded commit.";
            else if (/cannot fetch the MR/iu.test(stderr))
              mergeFailure =
                "The merge request commit could not be fetched. Check Git credentials and whether the commit is still available.";
          }
          if (["comment", "edit-comment", "delete-comment"].includes(input.operation)) {
            if (/unknown (?:flag|command)/iu.test(stderr))
              mergeFailure =
                "Upgrade the Depot CLI on this environment to a version with inline comments and comment editing.";
            else if (/changed since this diff was loaded/iu.test(stderr))
              mergeFailure =
                "The merge request changed. Refresh the diff and review the lines before commenting again.";
            else if (/permission_denied|only.*author|own comment/iu.test(stderr))
              mergeFailure =
                "Depot refused this comment change. Only the comment author can edit or delete it.";
          }
          if (["review", "reviews"].includes(input.operation)) {
            if (
              /unknown (?:flag|command)|unimplemented|not available on this server/iu.test(stderr)
            )
              mergeFailure = "Human reviews require an updated Depot CLI and API.";
            else if (/head moved/iu.test(stderr))
              mergeFailure =
                "The merge request head changed. Refresh and review it before submitting again.";
          }
          if (input.operation === "approve") {
            if (/unknown flag: --(?:id|expected-head-oid|withdraw)/iu.test(stderr))
              mergeFailure =
                "Upgrade the Depot CLI on this environment to a version with guarded MR approvals.";
            else if (/does not support guarded approvals/iu.test(stderr))
              mergeFailure =
                "This Depot server does not support guarded approvals; nothing was approved.";
            else if (/head (?:branch )?moved/iu.test(stderr))
              mergeFailure =
                "The merge request head changed. Refresh and review it before approving again.";
          }
          if (input.operation === "merge") {
            if (/unknown flag: --(?:id|expected-head-oid|expected-base-ref)/iu.test(stderr))
              mergeFailure =
                "Upgrade the Depot CLI on this environment to a version with ID-targeted MR merges.";
            else if (/(?:head|base) branch (?:moved|changed)/iu.test(stderr))
              mergeFailure =
                "The merge request head or destination changed. Refresh and review it before merging again.";
          }
          if (
            ["diff", "commits", "file"].includes(input.operation) &&
            /unknown (?:command|flag)/iu.test(stderr)
          )
            mergeFailure =
              "Upgrade the Depot CLI on this environment to a version with MR diff and history support.";
          return /unauthenticated|depot login|not logged in/iu.test(stderr)
            ? "authentication"
            : null;
        },
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new PullRequestProviderError({
              provider: definition.kind,
              operation: input.operation,
              reason: isSpawnError(cause)
                ? "missing-tool"
                : isExitError(cause) && cause.failureKind === "authentication"
                  ? "unauthenticated"
                  : "failed",
              detail:
                mergeFailure ??
                "Depot CLI request failed. Check repository access and run `depot login` on this environment if needed.",
              cause,
            }),
        ),
      );
  });
  const run: DepotCli["Service"]["run"] = Effect.fn("DepotCli.run")(function* (input, schema) {
    const output = yield* execute(input);
    if (output.stdoutTruncated || output.stdoutInvalidUtf8)
      return yield* failure(input.operation, "Depot returned an incomplete response.");
    return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(output.stdout).pipe(
      Effect.mapError(
        (cause) =>
          new PullRequestProviderError({
            provider: definition.kind,
            operation: input.operation,
            reason: "failed",
            detail: "Depot returned an invalid response.",
            cause,
          }),
      ),
    );
  });
  const scope: DepotCli["Service"]["scope"] = Effect.fn("DepotCli.scope")(function* (input) {
    const match = /^([a-z0-9]+)\/([a-z0-9]+)$/u.exec(input.repository);
    if (input.host !== "depot.dev" || !match)
      return yield* failure(
        "scope",
        "Specify a Depot merge request URL with its organization and repository IDs.",
      );
    return { org: match[1]!, args: ["--org", match[1]!, "--repo", match[2]!] };
  });
  const organization: DepotCli["Service"]["organization"] = Effect.fn("DepotCli.organization")(
    function* (cwd, remoteUrl) {
      const org = remoteUrl?.match(/(?:@|\/\/)([a-z0-9]+)\.code\.depot\.dev(?=[:/])/u)?.[1];
      if (org) return org;
      const output = yield* execute({ cwd, operation: "organization", args: ["org", "show"] });
      const current = output.stdout.trim();
      if (!/^[a-z0-9]+$/u.test(current))
        return yield* failure(
          "organization",
          "Select a Depot organization with `depot org switch` on this environment.",
        );
      return current;
    },
  );
  return DepotCli.of({ run, scope, organization });
});
export const layer = Layer.effect(DepotCli, make);
