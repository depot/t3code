import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type {
  ChangeRequestNumber,
  PullRequestCapabilities,
  PullRequestComment,
} from "@t3tools/contracts";
import type {
  PullRequestProviderApi,
  ProviderRepositoryRef,
} from "@t3tools/source-control-core/server/PullRequestProvider";
import { definition, isMergeRequestId } from "../shared/definition.ts";
import * as DepotCli from "./DepotCli.ts";
import * as DepotCodeReads from "./depotCodeReads.ts";
import * as Json from "./depotMergeRequests.ts";
import { depotReadiness } from "./depotReadiness.ts";

const capabilities: PullRequestCapabilities = {
  diff: true,
  comment: true,
  actions: [...definition.changeRequestActions],
  mergeMethods: ["merge", "squash"],
  search: false,
  reactions: false,
  review: {
    summary: true,
    batch: false,
    inlineComment: true,
    rangeComment: true,
    reply: true,
    resolve: true,
    verdicts: ["comment", "approve"],
  },
  reviewers: { request: false, listCandidates: false },
  edit: { changeRequest: true, comment: true },
};
type Reference = ProviderRepositoryRef & { readonly number: ChangeRequestNumber };
const unsupported = (operation: string) =>
  Effect.fail(
    DepotCli.failure(
      operation,
      "This operation is not available through the Depot CLI. Open the merge request in Depot Code.",
    ),
  );

export const make = Effect.gen(function* () {
  const cli = yield* DepotCli.DepotCli;
  const code = yield* DepotCodeReads.make;
  const read = Effect.fn("DepotPullRequestProvider.read")(function* (input: Reference) {
    const scope = yield* cli.scope(input);
    if (!isMergeRequestId(input.number))
      return yield* DepotCli.failure("read", "Specify a Depot merge request ID.");
    const detail = yield* cli.run(
      {
        cwd: input.cwd,
        operation: "read",
        args: ["mr", "view", ...scope.args, "--id", input.number, "--json"],
      },
      Json.Detail,
    );
    if (
      detail.mergeRequest.id !== input.number ||
      `${scope.org}/${detail.mergeRequest.repositoryId}` !== input.repository
    )
      return yield* DepotCli.failure("read", "Depot returned a different merge request.");
    return { ...detail, org: scope.org };
  });
  const write = Effect.fn("DepotPullRequestProvider.write")(function* (
    input: Reference,
    command: string,
    args: ReadonlyArray<string>,
    stdin?: string,
  ) {
    const scope = yield* cli.scope(input);
    if (!isMergeRequestId(input.number))
      return yield* DepotCli.failure(command, "Specify a Depot merge request ID.");
    yield* cli.run(
      {
        cwd: input.cwd,
        operation: command,
        args: ["mr", command, ...scope.args, ...args, "--json"],
        ...(stdin === undefined ? {} : { stdin }),
      },
      Schema.Unknown,
    );
  });
  const readThreads = Effect.fn("DepotPullRequestProvider.readThreads")(function* (
    input: Reference,
  ) {
    const scope = yield* cli.scope(input);
    if (!isMergeRequestId(input.number))
      return yield* DepotCli.failure("threads", "Specify a Depot merge request ID.");
    const threads = yield* cli.run(
      {
        cwd: input.cwd,
        operation: "threads",
        args: ["mr", "threads", ...scope.args, "--id", String(input.number), "--json"],
      },
      Json.Threads,
    );
    if (threads.mergeRequestId !== input.number)
      return yield* DepotCli.failure(
        "threads",
        "Depot returned threads for a different merge request.",
      );
    return threads;
  });
  const requireThread = Effect.fn("DepotPullRequestProvider.requireThread")(function* (
    input: Reference & { readonly threadId: string },
  ) {
    if (!/^[a-z][a-z0-9_]+$/u.test(input.threadId))
      return yield* DepotCli.failure("thread", "Invalid Depot review thread ID.");
    const threads = yield* readThreads(input);
    if (!threads.threads.some((thread) => thread.id === input.threadId))
      return yield* DepotCli.failure(
        "thread",
        "The review thread does not belong to this merge request.",
      );
  });
  const comment = (
    value: typeof Json.Comment.Type,
    url: string,
    path: string | null = null,
  ): PullRequestComment => ({
    id: value.id,
    kind: path === null ? "issue-comment" : "review-comment",
    author: Json.actor(value.author),
    body: value.body ?? "",
    createdAt: value.createdAt,
    editedAt: value.editedAt ?? null,
    url,
    path,
    reviewState: null,
    canEdit: value.canEdit ?? false,
  });
  return {
    kind: definition.kind,
    capabilities,
    servesHost: (host) => host === "depot.dev",
    readsPublicHostWithoutCheckout: true,
    repositoryKey: ({ canonicalKey }) => canonicalKey.replace(/^depot\.dev\//u, ""),
    unavailableRequirement: {
      missing: "Install the Depot CLI on this environment and run `depot login`.",
      unauthenticated: "Run `depot login` on this environment.",
    },
    getViewer: Effect.fn("DepotPullRequestProvider.getViewer")(function* (input) {
      if (input.host && input.host !== "depot.dev")
        return yield* DepotCli.failure("viewer", "Specify a Depot host.");
      const org = yield* cli.organization(input.cwd);
      const data = yield* cli.run(
        { cwd: input.cwd, operation: "viewer", args: ["mr", "viewer", "--org", org, "--json"] },
        Json.Viewer,
      );
      if (data.orgId !== org || data.viewer.kind !== "KIND_USER" || !data.viewer.id)
        return yield* DepotCli.failure(
          "viewer",
          "Depot returned a different organization or no authenticated user.",
        );
      return data.viewer.id;
    }),
    listChangeRequests: Effect.fn("DepotPullRequestProvider.listChangeRequests")(function* (input) {
      const scope = yield* cli.scope(input);
      if (input.involvement === "reviewing")
        return { items: [], truncated: false, continues: false };
      const page = yield* cli.run(
        {
          cwd: input.cwd,
          operation: "list",
          args: [
            "mr",
            "list",
            ...scope.args,
            "--state",
            input.state,
            "--limit",
            String(Math.min(input.limit, 100)),
            "--json",
            ...(input.involvement === "authored" ? ["--author", "@me"] : []),
            ...(input.cursor?.resumeAfter ? ["--page-token", input.cursor.resumeAfter] : []),
          ],
        },
        Json.List,
      );
      return {
        items: (page.mergeRequests ?? []).map((mr) => ({
          ...Json.summary(mr, scope.org),
          mergeability: "unknown" as const,
          additions: 0,
          deletions: 0,
          createdAt: mr.createdAt,
          reviewRequestLogins: [],
          labels: [],
        })),
        truncated: false,
        continues: Boolean(page.nextPageToken),
        ...(page.nextPageToken ? { resumeAfter: page.nextPageToken } : {}),
      };
    }),
    getChangeRequestSummary: Effect.fn("DepotPullRequestProvider.getChangeRequestSummary")(
      function* (input) {
        const data = yield* read(input);
        const { checksState, reviewDecision, mergeability } = depotReadiness(data, data.org);
        return {
          ...Json.summary(data.mergeRequest, data.org),
          checksState,
          reviewDecision,
          mergeability,
        };
      },
    ),
    getChangeRequestChecks: Effect.fn("DepotPullRequestProvider.getChangeRequestChecks")(
      function* (input) {
        const data = yield* read(input);
        return {
          state: Json.summary(data.mergeRequest, data.org).state,
          checks: depotReadiness(data, data.org).checks,
        };
      },
    ),
    getChangeRequest: Effect.fn("DepotPullRequestProvider.getChangeRequest")(function* (input) {
      const data = yield* read(input);
      const mr = data.mergeRequest;
      const stats = yield* code.stats(input);
      if (stats.headOid !== mr.headOid)
        return yield* DepotCli.failure("diff", "The merge request changed. Refresh and try again.");
      return {
        ...Json.summary(mr, data.org),
        ...depotReadiness(data, data.org),
        body: mr.body ?? "",
        additions: stats.additions,
        deletions: stats.deletions,
        changedFiles: stats.changedFiles,
        statsIncomplete: stats.statsIncomplete,
        createdAt: mr.createdAt,
        labels: [],
        reviewRequestLogins: [],
        mergeCapabilities: { merge: true, squash: true, rebase: false },
        viewerPermissions: Json.viewerPermissions(data),
      };
    }),
    getChangeRequestActivity: Effect.fn("DepotPullRequestProvider.getChangeRequestActivity")(
      function* (input) {
        const data = yield* read(input);
        const url = Json.summary(data.mergeRequest, data.org).url;
        const threads = yield* readThreads(input);
        const comments: PullRequestComment[] = threads.comments
          .filter((entry) => !entry.deletedAt)
          .map((entry) => comment(entry, url));
        return {
          comments,
          commentCount: comments.length,
          commentsTruncated: false,
          commits: yield* code.commits(input),
          reviewThreads: threads.threads.map((thread) => ({
            id: thread.id,
            path: thread.path,
            line: thread.endLine || null,
            side:
              thread.side === "old" || thread.side === "left"
                ? ("left" as const)
                : ("right" as const),
            isResolved: thread.resolved,
            isOutdated: thread.outdated,
            comments: thread.comments
              .filter((entry) => !entry.deletedAt)
              .map((entry) => comment(entry, url, thread.path)),
          })),
        };
      },
    ),
    getViewerPermissions: Effect.fn("DepotPullRequestProvider.getViewerPermissions")(
      function* (input) {
        return Json.viewerPermissions(yield* read(input));
      },
    ),
    runAction: Effect.fn("DepotPullRequestProvider.runAction")(function* (input) {
      if (input.action === "merge") {
        if (
          input.stackNumber !== undefined ||
          (input.mergeMethod !== undefined &&
            input.mergeMethod !== "merge" &&
            input.mergeMethod !== "squash")
        )
          return yield* unsupported("merge");
        const { mergeRequest: mr, org } = yield* read(input);
        if (
          mr.state !== "STATE_OPEN" ||
          mr.headBranchDeleted ||
          !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(mr.headOid) ||
          !mr.baseRef
        )
          return yield* DepotCli.failure(
            "merge",
            "Refresh the merge request before merging; it must be open with an available head and destination.",
          );
        const scope = yield* cli.scope(input);
        const result = yield* cli.run(
          {
            cwd: input.cwd,
            operation: "merge",
            args: [
              "mr",
              "merge",
              ...scope.args,
              "--id",
              mr.id,
              "--expected-head-oid",
              mr.headOid,
              "--expected-base-ref",
              mr.baseRef,
              ...(input.mergeMethod === "squash" ? ["--squash"] : []),
              "--json",
            ],
          },
          Json.Detail,
        );
        const merged = result.mergeRequest;
        if (
          merged.id !== mr.id ||
          merged.repositoryId !== mr.repositoryId ||
          merged.headOid !== mr.headOid ||
          merged.baseRef !== mr.baseRef ||
          merged.state !== "STATE_MERGED" ||
          !merged.mergeCommitOid
        )
          return yield* DepotCli.failure(
            "merge",
            "Depot did not confirm the requested merge. Refresh its state before trying again.",
          );
        return Json.summary(merged, org);
      }
      if (input.action === "withdraw-approval") {
        yield* write(input, "approve", ["--id", String(input.number), "--withdraw"]);
        const data = yield* read(input);
        return Json.summary(data.mergeRequest, data.org);
      }
      if (input.action !== "close" && input.action !== "reopen")
        return yield* unsupported(input.action);
      yield* write(input, input.action, ["--id", String(input.number)]);
      const data = yield* read(input);
      return Json.summary(data.mergeRequest, data.org);
    }),
    updateChangeRequest: Effect.fn("DepotPullRequestProvider.updateChangeRequest")(
      function* (input) {
        yield* write(
          input,
          "edit",
          [
            "--id",
            String(input.number),
            ...(input.title === undefined ? [] : ["--title", input.title]),
            ...(input.body === undefined ? [] : ["--body-file", "-"]),
          ],
          input.body,
        );
      },
    ),
    replyToThread: Effect.fn("DepotPullRequestProvider.replyToThread")(function* (input) {
      yield* requireThread(input);
      yield* write(input, "reply", [input.threadId, "--body-file", "-"], input.body);
    }),
    setThreadResolution: Effect.fn("DepotPullRequestProvider.setThreadResolution")(
      function* (input) {
        yield* requireThread(input);
        yield* write(input, input.resolved ? "resolve" : "unresolve", [input.threadId]);
      },
    ),
    getDiff: code.getDiff,
    getDiffFilePaths: code.getDiffFilePaths,
    getDiffFileContents: code.getDiffFileContents,
    getFileStats: code.getFileStats,
    comment: Effect.fn("DepotPullRequestProvider.comment")(function* (input) {
      yield* write(
        input,
        "comment",
        ["--id", String(input.number), "--body-file", "-"],
        input.body,
      );
    }),
    updateComment: Effect.fn("DepotPullRequestProvider.updateComment")(function* (input) {
      if (!/^[a-z][a-z0-9_]+$/u.test(input.commentId))
        return yield* DepotCli.failure("edit-comment", "Invalid Depot comment ID.");
      const threads = yield* readThreads(input);
      const comments =
        input.kind === "issue-comment"
          ? threads.comments
          : threads.threads.flatMap((thread) => thread.comments);
      if (!comments.some((comment) => comment.id === input.commentId && !comment.deletedAt))
        return yield* DepotCli.failure(
          "edit-comment",
          "The comment does not belong to this merge request or was deleted.",
        );
      yield* write(
        input,
        "edit-comment",
        [input.commentId, "--id", String(input.number), "--body-file", "-"],
        input.body,
      );
    }),
    submitReview: Effect.fn("DepotPullRequestProvider.submitReview")(function* (input) {
      if (input.verdict !== "approve" && input.verdict !== "comment")
        return yield* unsupported("review");
      if (
        input.comments.length +
          (input.body.trim() ? 1 : 0) +
          (input.verdict === "approve" ? 1 : 0) !==
        1
      )
        return yield* DepotCli.failure(
          "review",
          "Submit each Depot comment and approval separately.",
        );
      if (input.verdict === "comment") {
        const draft = input.comments[0];
        if (!draft) {
          yield* write(
            input,
            "comment",
            ["--id", String(input.number), "--body-file", "-"],
            input.body,
          );
          return;
        }
        const revision = draft.reviewRevision;
        if (
          !revision ||
          !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(revision.headOid) ||
          (revision.baseOid !== "" && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(revision.baseOid))
        )
          return yield* DepotCli.failure(
            "comment",
            "Refresh the diff and recreate this comment to capture its reviewed revision.",
          );
        const line = (position: typeof draft.position) =>
          position.kind === "deleted" || (position.kind === "context" && position.side === "left")
            ? { side: "old", number: position.oldLine }
            : { side: "new", number: position.newLine };
        const end = line(draft.position);
        const start = line(draft.startPosition ?? draft.position);
        if (start.side !== end.side || start.number < 1 || start.number > end.number)
          return yield* DepotCli.failure(
            "comment",
            "Select an inclusive line range on one side of the diff.",
          );
        yield* write(
          input,
          "comment",
          [
            "--id",
            String(input.number),
            "--body-file",
            "-",
            "--path",
            end.side === "old" ? (draft.oldPath ?? draft.path) : draft.path,
            "--side",
            end.side,
            "--line",
            String(end.number),
            "--start-line",
            String(start.number),
            "--head-oid",
            revision.headOid,
            "--base-oid",
            revision.baseOid,
          ],
          draft.body,
        );
        return;
      }
      if (!input.expectedHeadOid || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(input.expectedHeadOid))
        return yield* DepotCli.failure(
          "approve",
          "Refresh and review the merge request before approving it.",
        );
      const scope = yield* cli.scope(input);
      if (!isMergeRequestId(input.number))
        return yield* DepotCli.failure("approve", "Specify a Depot merge request ID.");
      const result = yield* cli.run(
        {
          cwd: input.cwd,
          operation: "approve",
          args: [
            "mr",
            "approve",
            ...scope.args,
            "--id",
            input.number,
            "--expected-head-oid",
            input.expectedHeadOid,
            "--json",
          ],
        },
        Schema.Struct({
          approval: Schema.Struct({
            mergeRequestId: Schema.String,
            headOid: Schema.String,
            withdrawnAt: Schema.optional(Schema.String),
          }),
        }),
      );
      if (
        result.approval.mergeRequestId !== input.number ||
        result.approval.headOid !== input.expectedHeadOid ||
        result.approval.withdrawnAt
      )
        return yield* DepotCli.failure(
          "approve",
          "Depot did not confirm the requested approval. Refresh its state before trying again.",
        );
    }),
    listReviewerCandidates: () => unsupported("reviewers"),
    setReviewerRequest: () => unsupported("reviewers"),
    setReaction: () => unsupported("reaction"),
  } satisfies PullRequestProviderApi;
});
