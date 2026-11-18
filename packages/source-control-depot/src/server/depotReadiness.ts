import type {
  PullRequestCheck,
  PullRequestCheckStatus,
  PullRequestChecksState,
  PullRequestMergeability,
} from "@t3tools/contracts";
import * as Json from "./depotMergeRequests.ts";

function checkStatus(state: string | undefined): PullRequestCheckStatus {
  switch (state) {
    case "MERGE_REQUEST_CHECK_STATE_PASSED":
    case "MERGE_REQUEST_CHECK_STATE_FINDINGS":
      return "success";
    case "MERGE_REQUEST_CHECK_STATE_FAILED":
      return "failure";
    case "MERGE_REQUEST_CHECK_STATE_CANCELLED":
      return "cancelled";
    default:
      return "pending";
  }
}

export function depotReadiness(data: typeof Json.Detail.Type, org: string) {
  const mr = data.mergeRequest;
  // Readiness describes one head; stale checks and approvals cannot describe its replacement.
  const readiness =
    mr.state === "STATE_OPEN" && data.readiness?.headOid === mr.headOid
      ? data.readiness
      : undefined;
  const root = `https://depot.dev/orgs/${encodeURIComponent(org)}`;
  const checks: PullRequestCheck[] = [];
  for (const workflow of readiness?.ciWorkflows ?? []) {
    checks.push({
      name: workflow.name?.trim() || workflow.workflowId,
      status: checkStatus(workflow.state),
      description: "Depot CI",
      url: `${root}/workflows/${encodeURIComponent(workflow.workflowId)}`,
    });
  }
  for (const check of readiness?.agentChecks ?? []) {
    const findings = check.openFindings ?? 0;
    checks.push({
      name: check.agentName?.trim() || check.agentId,
      status: checkStatus(check.state),
      description:
        findings > 0
          ? `${findings} open ${findings === 1 ? "finding" : "findings"}`
          : "Depot Agent Check",
      url: `${root}/agents/checks?${new URLSearchParams({ agent: check.agentId, check: check.attemptId })}`,
    });
  }
  for (const [name, state, count] of [
    ["Depot CI", readiness?.ciState, readiness?.ciWorkflows?.length ?? 0],
    ["Depot Agent Checks", readiness?.agentChecksState, readiness?.agentChecks?.length ?? 0],
  ] as const) {
    if (count === 0 && state && state !== "MERGE_REQUEST_CHECK_STATE_UNSPECIFIED") {
      checks.push({ name, status: checkStatus(state), description: null, url: null });
    }
  }
  const incomplete =
    readiness?.checksIncomplete ||
    readiness?.reasons?.some((reason) => reason.kind === "KIND_STATUSES_UNAVAILABLE");
  if (mr.state === "STATE_OPEN" && (!readiness || incomplete)) {
    checks.push({
      name: "Depot checks unavailable",
      status: "pending",
      description: !readiness
        ? "Readiness is unavailable for the current head."
        : "Some checks could not be read.",
      url: Json.summary(mr, org).url,
      placeholder: true,
    });
  }
  const checksState: PullRequestChecksState | null = checks.some(
    (check) => check.status === "failure" || check.status === "cancelled",
  )
    ? "failing"
    : checks.some((check) => check.status === "pending")
      ? "pending"
      : checks.length > 0
        ? "passing"
        : null;
  const mergeability: PullRequestMergeability =
    readiness?.mergeability === "MERGEABILITY_CLEAN"
      ? "mergeable"
      : readiness?.mergeability === "MERGEABILITY_CONFLICTING"
        ? "conflicting"
        : "unknown";
  const approvals =
    readiness?.countingApprovals ??
    (mr.state === "STATE_OPEN"
      ? []
      : (data.approvals ?? []).filter(
          (approval) => approval.approver.kind === "KIND_USER" || approval.headOid === mr.headOid,
        ));
  const reviewers = approvals
    .filter((approval) => !approval.withdrawnAt)
    .map((approval) => Json.actor(approval.approver)!);
  return {
    checks,
    checksState,
    mergeability,
    reviewers,
    reviewDecision: readiness && reviewers.length > 0 ? ("approved" as const) : null,
  };
}
