import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { SourceControlProviderError } from "@t3tools/contracts";
import { PullRequestProviderError } from "@t3tools/source-control-core/server/PullRequestProvider";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import {
  providerAuth,
  type SourceControlCliDiscoverySpec,
} from "@t3tools/source-control-core/server/discovery";
import { definition, isMergeRequestId, parseChangeRequestUrl } from "../shared/definition.ts";
import * as DepotCli from "./DepotCli.ts";
import * as Json from "./depotMergeRequests.ts";
import * as Repositories from "./depotRepositories.ts";

export const discovery: SourceControlCliDiscoverySpec = {
  type: "cli",
  kind: definition.kind,
  label: definition.label,
  executable: "depot",
  versionArgs: ["--version"],
  authArgs: ["org", "list", "--output", "json"],
  parseAuth: ({ exitCode }) =>
    providerAuth(
      exitCode === 0
        ? { status: "authenticated", host: "depot.dev" }
        : { status: "unauthenticated", detail: "Run `depot login` on this environment." },
    ),
  installHint: "Install the Depot CLI and run `depot login` on this environment.",
};

const isPullRequestProviderError = Schema.is(PullRequestProviderError);

export const make = Effect.gen(function* () {
  const cli = yield* DepotCli.DepotCli;
  const scope = Effect.fn("DepotSourceControlProvider.scope")(function* (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
  }) {
    const org = yield* cli.organization(input.cwd, input.context?.remoteUrl);
    return { org, args: ["--org", org] };
  });
  const mapError = (operation: string, cwd: string) =>
    Effect.mapError(
      (cause: unknown) =>
        new SourceControlProviderError({
          provider: definition.kind,
          operation,
          cwd,
          command: "depot",
          detail: isPullRequestProviderError(cause)
            ? cause.detail
            : "Depot Code operation failed. Check the Depot CLI login and repository access on this environment.",
          cause,
        }),
    );
  const readRepository = Effect.fn("DepotSourceControlProvider.readRepository")(function* (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
  }) {
    const selected = yield* scope(input);
    const repo = yield* cli.run(
      {
        cwd: input.cwd,
        operation: "repository",
        args: [
          "code",
          "repo",
          "view",
          ...selected.args,
          "--output",
          "json",
          ...(input.context
            ? ["--remote", Repositories.remoteArgument(input.context.remoteUrl)]
            : []),
        ],
      },
      Repositories.Repository,
    );
    return { repo, org: selected.org };
  });
  return SourceControlProvider.SourceControlProvider.of({
    kind: definition.kind,
    refineRepositoryIdentity: Effect.fn("DepotSourceControlProvider.refineRepositoryIdentity")(
      function* ({ identity }) {
        if (identity.provider !== definition.kind || !identity.rootPath) return identity;
        const org = yield* cli.organization(identity.rootPath, identity.locator.remoteUrl);
        const repo = yield* cli.run(
          {
            cwd: identity.rootPath,
            operation: "repository",
            args: [
              "code",
              "repo",
              "view",
              "--org",
              org,
              "--remote",
              Repositories.remoteArgument(identity.locator.remoteUrl),
              "--output",
              "json",
            ],
          },
          Repositories.Repository,
        );
        return {
          ...identity,
          canonicalKey: `depot.dev/${org}/${repo.repositoryId}`,
          webUrl: `https://depot.dev/orgs/${org}/code/repositories/${repo.repositoryId}`,
          owner: org,
          name: repo.name,
          displayName: `${org}/${repo.name}`,
        };
      },
      (effect, input) => effect.pipe(mapError("identity", input.identity.rootPath ?? ".")),
    ),
    listChangeRequests: Effect.fn("DepotSourceControlProvider.listChangeRequests")(
      function* (input) {
        const selected = yield* scope(input);
        const page = yield* cli.run(
          {
            cwd: input.cwd,
            operation: "list",
            args: [
              "mr",
              "list",
              ...selected.args,
              "--head",
              SourceControlProvider.sourceBranch(input),
              "--state",
              input.state,
              "--limit",
              String(Math.min(input.limit ?? 20, 100)),
              "--json",
            ],
          },
          Json.List,
        );
        return (page.mergeRequests ?? []).map((mr) => Json.changeRequest(mr, selected.org));
      },
      (effect, input) => effect.pipe(mapError("list", input.cwd)),
    ),
    getChangeRequest: Effect.fn("DepotSourceControlProvider.getChangeRequest")(
      function* (input) {
        const link = URL.canParse(input.reference)
          ? parseChangeRequestUrl(new URL(input.reference))
          : null;
        if (URL.canParse(input.reference) && !link)
          return yield* DepotCli.failure("get", "Specify a Depot merge request URL.");
        const selected = link ? yield* cli.scope({ cwd: input.cwd, ...link }) : yield* scope(input);
        const reference = link?.number ?? input.reference;
        const data = yield* cli.run(
          {
            cwd: input.cwd,
            operation: "get",
            args: [
              "mr",
              "view",
              ...selected.args,
              "--json",
              ...(isMergeRequestId(reference) ? ["--id", reference] : ["--", String(reference)]),
            ],
          },
          Json.Detail,
        );
        if (
          link &&
          (data.mergeRequest.id !== link.number ||
            `${selected.org}/${data.mergeRequest.repositoryId}` !== link.repository)
        )
          return yield* DepotCli.failure("get", "Depot returned a different merge request.");
        const local = yield* readRepository(input);
        if (
          local.org !== selected.org ||
          local.repo.repositoryId !== data.mergeRequest.repositoryId
        )
          return yield* DepotCli.failure(
            "get",
            "This merge request belongs to another repository. Open its repository before checking it out.",
          );
        return Json.changeRequest(data.mergeRequest, selected.org);
      },
      (effect, input) => effect.pipe(mapError("get", input.cwd)),
    ),
    createChangeRequest: Effect.fn("DepotSourceControlProvider.createChangeRequest")(
      function* (input) {
        const selected = yield* scope(input);
        yield* cli.run(
          {
            cwd: input.cwd,
            operation: "create",
            args: [
              "mr",
              "create",
              ...selected.args,
              "--title",
              input.title,
              "--body-file",
              input.bodyFile,
              "--head",
              SourceControlProvider.sourceBranch(input),
              "--base",
              input.target?.refName ?? input.baseRefName,
              "--json",
            ],
          },
          Schema.Unknown,
        );
      },
      (effect, input) => effect.pipe(mapError("create", input.cwd)),
    ),
    getRepositoryCloneUrls: Effect.fn("DepotSourceControlProvider.getRepositoryCloneUrls")(
      function* (input) {
        if (input.host && input.host !== "depot.dev")
          return yield* DepotCli.failure("repository", "Specify a Depot Code repository.");
        const selector = Repositories.repositorySelector(input.repository);
        if (!selector)
          return yield* DepotCli.failure(
            "repository",
            "Use organization/repository or a Depot repository URL.",
          );
        const org = selector.org ?? (yield* cli.organization(input.cwd, input.context?.remoteUrl));
        const repo = yield* cli.run(
          {
            cwd: input.cwd,
            operation: "repository",
            args: ["code", "repo", "view", "--org", org, "--output", "json", ...selector.args],
          },
          Repositories.Repository,
        );
        return Repositories.cloneUrls(repo, org);
      },
      (effect, input) => effect.pipe(mapError("clone", input.cwd)),
    ),
    createRepository: Effect.fn("DepotSourceControlProvider.createRepository")(
      function* (input) {
        if (input.visibility !== "private")
          return yield* DepotCli.failure(
            "createRepository",
            "Depot Code repositories are private to their organization.",
          );
        const selector = Repositories.repositorySelector(input.repository);
        if (!selector || selector.args[0] !== "--")
          return yield* DepotCli.failure(
            "createRepository",
            "Use organization/repository to name a new Depot repository.",
          );
        const org = selector.org ?? (yield* cli.organization(input.cwd));
        const repo = yield* cli.run(
          {
            cwd: input.cwd,
            operation: "repository",
            args: ["code", "repo", "create", "--org", org, "--output", "json", ...selector.args],
          },
          Repositories.Repository,
        );
        return Repositories.cloneUrls(repo, org);
      },
      (effect, input) => effect.pipe(mapError("createRepository", input.cwd)),
    ),
    getDefaultBranch: Effect.fn("DepotSourceControlProvider.getDefaultBranch")(
      function* (input) {
        return (yield* readRepository(input)).repo.defaultBranch || null;
      },
      (effect, input) => effect.pipe(mapError("defaultBranch", input.cwd)),
    ),
    checkoutChangeRequest: Effect.fn("DepotSourceControlProvider.checkoutChangeRequest")(
      function* (input) {
        const link = URL.canParse(input.reference)
          ? parseChangeRequestUrl(new URL(input.reference))
          : null;
        if (URL.canParse(input.reference) && !link)
          return yield* DepotCli.failure("checkout", "Specify a Depot merge request URL.");
        const selected = link ? yield* cli.scope({ cwd: input.cwd, ...link }) : yield* scope(input);
        const reference = link?.number ?? input.reference;
        yield* cli.run(
          {
            cwd: input.cwd,
            operation: "checkout",
            args: [
              "mr",
              "checkout",
              ...selected.args,
              "--json",
              ...(input.force ? ["--force"] : []),
              ...(isMergeRequestId(reference) ? ["--id", reference] : ["--", String(reference)]),
            ],
          },
          Schema.Unknown,
        );
      },
      (effect, input) => effect.pipe(mapError("checkout", input.cwd)),
    ),
  });
});
