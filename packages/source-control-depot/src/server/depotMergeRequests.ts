import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as DateTime from "effect/DateTime";
import type {
  ChangeRequest,
  PullRequestActor,
  PullRequestViewerPermissions,
} from "@t3tools/contracts";
import { definition } from "../shared/definition.ts";

const OptionalString = Schema.optional(Schema.String);
export const Actor = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  displayName: OptionalString,
});
export const Viewer = Schema.Struct({ orgId: Schema.String, viewer: Actor });
const ViewerPermissions = Schema.Struct({
  canComment: Schema.optional(Schema.Boolean),
  canCommentInline: Schema.optional(Schema.Boolean),
  canResolveThreads: Schema.optional(Schema.Boolean),
  canEdit: Schema.optional(Schema.Boolean),
  canClose: Schema.optional(Schema.Boolean),
  canReopen: Schema.optional(Schema.Boolean),
  canMerge: Schema.optional(Schema.Boolean),
  canApprove: Schema.optional(Schema.Boolean),
  canWithdrawApproval: Schema.optional(Schema.Boolean),
});
export const MergeRequest = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^mr_[a-z0-9]+$/u)),
  repositoryId: Schema.String,
  title: Schema.String,
  body: OptionalString,
  state: Schema.Literals(["STATE_OPEN", "STATE_CLOSED", "STATE_MERGED"]),
  headRef: Schema.String,
  headOid: Schema.String,
  headBranchDeleted: Schema.optional(Schema.Boolean),
  baseRef: Schema.String,
  baseOid: OptionalString,
  author: Schema.optional(Actor),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  mergedAt: OptionalString,
  mergeCommitOid: OptionalString,
  closedAt: OptionalString,
});
export type MergeRequest = typeof MergeRequest.Type;
export const Comment = Schema.Struct({
  canEdit: Schema.optional(Schema.Boolean),
  id: Schema.String,
  author: Schema.optional(Actor),
  body: OptionalString,
  createdAt: Schema.String,
  editedAt: OptionalString,
  deletedAt: OptionalString,
});
const Approval = Schema.Struct({
  approver: Actor,
  headOid: Schema.String,
  createdAt: Schema.String,
  withdrawnAt: OptionalString,
});
const Readiness = Schema.Struct({
  headOid: Schema.String,
  mergeability: OptionalString,
  checksIncomplete: Schema.optional(Schema.Boolean),
  reasons: Schema.optional(Schema.Array(Schema.Struct({ kind: OptionalString }))),
  ciState: OptionalString,
  agentChecksState: OptionalString,
  countingApprovals: Schema.optional(Schema.Array(Approval)),
  ciWorkflows: Schema.optional(
    Schema.Array(
      Schema.Struct({
        workflowId: Schema.String,
        name: OptionalString,
        state: OptionalString,
      }),
    ),
  ),
  agentChecks: Schema.optional(
    Schema.Array(
      Schema.Struct({
        attemptId: Schema.String,
        agentId: Schema.String,
        agentName: OptionalString,
        state: OptionalString,
        openFindings: Schema.optional(Schema.Number),
      }),
    ),
  ),
});
export const Detail = Schema.Struct({
  viewer: Schema.optional(Actor),
  viewerPermissions: Schema.optional(ViewerPermissions),
  mergeRequest: MergeRequest,
  comments: Schema.optional(Schema.Array(Comment)),
  approvals: Schema.optional(Schema.Array(Approval)),
  readiness: Schema.optional(Readiness),
});
export const List = Schema.Struct({
  mergeRequests: Schema.optional(Schema.Array(MergeRequest)),
  nextPageToken: OptionalString,
});
export const Threads = Schema.Struct({
  mergeRequestId: Schema.String,
  threads: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      path: Schema.String,
      side: Schema.String,
      startLine: Schema.Number,
      endLine: Schema.Number,
      resolved: Schema.Boolean,
      outdated: Schema.Boolean,
      comments: Schema.Array(Comment),
    }),
  ),
  comments: Schema.Array(Comment),
});

export function actor(value: typeof Actor.Type | undefined): PullRequestActor | null {
  return value
    ? {
        login: value.id,
        name: value.displayName || null,
        avatarUrl: null,
        isBot: value.kind !== "KIND_USER",
      }
    : null;
}

export function summary(mr: MergeRequest, org: string) {
  return {
    number: mr.id,
    title: mr.title,
    url: definition.changeRequestUrl({
      host: "depot.dev",
      repository: `${org}/${mr.repositoryId}`,
      number: mr.id,
    })!,
    state:
      mr.state === "STATE_MERGED"
        ? ("merged" as const)
        : mr.state === "STATE_CLOSED"
          ? ("closed" as const)
          : ("open" as const),
    headBranch: mr.headRef,
    baseBranch: mr.baseRef,
    headSha: mr.headOid,
    isDraft: false,
    updatedAt: mr.updatedAt,
    mergedAt: mr.mergedAt ?? null,
    closedAt: mr.closedAt ?? null,
    author: actor(mr.author),
  };
}

export function changeRequest(mr: MergeRequest, org: string): ChangeRequest {
  const value = summary(mr, org);
  return {
    provider: definition.kind,
    number: value.number,
    title: value.title,
    url: value.url,
    baseRefName: value.baseBranch,
    headRefName: value.headBranch,
    headSha: mr.headOid,
    state: value.state,
    isDraft: false,
    mergedAt: value.mergedAt,
    closedAt: value.closedAt,
    updatedAt: Option.map(DateTime.make(mr.updatedAt), DateTime.toUtc),
  };
}

export function viewerPermissions(data: typeof Detail.Type): PullRequestViewerPermissions {
  const p = data.viewerPermissions;
  return {
    actions: [
      ...(p?.canMerge ? ["merge" as const] : []),
      ...(p?.canClose ? ["close" as const] : []),
      ...(p?.canReopen ? ["reopen" as const] : []),
      ...(p?.canWithdrawApproval ? ["withdraw-approval" as const] : []),
    ],
    comment: p?.canComment ?? false,
    resolve: p?.canResolveThreads ?? false,
    editChangeRequest: p?.canEdit ?? false,
    verdicts: [
      ...(p?.canComment ? ["comment" as const] : []),
      ...(p?.canApprove ? ["approve" as const] : []),
    ],
    requestReviewers: false,
  };
}
