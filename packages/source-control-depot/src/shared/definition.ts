import { SourceControlProviderKind } from "@t3tools/contracts";
import {
  defineSourceControl,
  type ParsedChangeRequestUrl,
} from "@t3tools/source-control-core/shared/definition";

const KIND = SourceControlProviderKind.make("depot");
const REPOSITORY_PATH = /^\/orgs\/([a-z0-9]+)\/code\/repositories\/([a-z0-9]+)(?:\/|$)/u;
export const isMergeRequestId = (value: unknown): value is string =>
  typeof value === "string" && /^mr_[a-z0-9]+$/u.test(value);

export function parseChangeRequestUrl(url: URL): ParsedChangeRequestUrl | null {
  if (
    url.protocol !== "https:" ||
    url.hostname !== "depot.dev" ||
    url.port ||
    url.username ||
    url.password
  )
    return null;
  const match = /^\/orgs\/([a-z0-9]+)\/code\/repositories\/([a-z0-9]+)\/merge-requests\/?$/u.exec(
    url.pathname,
  );
  const id = url.searchParams.get("id");
  return match && isMergeRequestId(id)
    ? {
        host: "depot.dev",
        repository: `${match[1]}/${match[2]}`,
        number: id,
        repositoryUrl: `https://depot.dev/orgs/${match[1]}/code/repositories/${match[2]}`,
      }
    : null;
}

export const definition = defineSourceControl({
  kind: KIND,
  label: "Depot Code",
  pickerLabel: "Depot Code",
  icon: null,
  searchKeywords: ["depot", "merge requests"],
  changeRequest: {
    shortLabel: "MR",
    shortLabelWithArticle: "an MR",
    singular: "merge request",
    plural: "merge requests",
  },
  repositoryPathHint: "organization/repository",
  publicHost: "depot.dev",
  canonicalRepositoryKey: (key) => (/^depot\.dev\/[a-z0-9]+\/[a-z0-9]+$/u.test(key) ? key : null),
  publishDescription: "Depot Code",
  publishHost: () => "code.depot.dev",
  newRepositoryOwner: () => ({ owner: null }),
  defaultCloneTransport: "https",
  changeRequestUrl: ({ repository, number, webUrl }) => {
    const page = webUrl && URL.canParse(webUrl) ? new URL(webUrl) : null;
    const path =
      page?.protocol === "https:" && page.host === "depot.dev"
        ? REPOSITORY_PATH.exec(page.pathname)
        : null;
    if (path) repository = `${path[1]}/${path[2]}`;
    const match = /^([a-z0-9]+)\/([a-z0-9]+)$/u.exec(repository);
    return match && isMergeRequestId(number)
      ? `https://depot.dev/orgs/${match[1]}/code/repositories/${match[2]}/merge-requests?id=${number}`
      : null;
  },
  parseChangeRequestUrl,
  repositoryUrlFromPage: (url) => {
    const match = url.hostname === "depot.dev" ? REPOSITORY_PATH.exec(url.pathname) : null;
    return match ? `https://depot.dev/orgs/${match[1]}/code/repositories/${match[2]}` : null;
  },
  changeRequestUrlFromReferenceAutolink: () => null,
  changeRequestActions: new Set(["merge", "close", "reopen", "withdraw-approval"] as const),
  checkoutCommand: ({ number, repositoryUrl }) => {
    const path =
      repositoryUrl && URL.canParse(repositoryUrl)
        ? REPOSITORY_PATH.exec(new URL(repositoryUrl).pathname)
        : null;
    return isMergeRequestId(number) && path
      ? `depot mr checkout --id ${number} --org ${path[1]} --repo ${path[2]}`
      : null;
  },
  changeRequestHeadRef: (_number, headSha) =>
    headSha && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(headSha) ? headSha : undefined,
  changeRequestCloseCommand: /\bdepot\s+mr\s+(?:merge|close)\b/u,
  authorProfileUrl: () => null,
  reviewSummaryRequired: () => false,
  checkoutCommandArgument: (input) => {
    const match =
      /^depot mr checkout --id (mr_[a-z0-9]+) --org ([a-z0-9]+) --repo ([a-z0-9]+)$/u.exec(
        input.trim(),
      );
    return match
      ? `https://depot.dev/orgs/${match[2]}/code/repositories/${match[3]}/merge-requests?id=${match[1]}`
      : null;
  },
  isChangeRequestReference: (value) =>
    URL.canParse(value) && parseChangeRequestUrl(new URL(value)) !== null,
  checkoutChangeRequestHost: () => "depot.dev",
  recognizeRemote: ({ hostname }) =>
    hostname === "depot.dev" ||
    hostname === "code.depot.dev" ||
    /^[a-z0-9]+\.code\.depot\.dev$/u.test(hostname)
      ? { kind: KIND, name: "Depot Code", baseUrl: "https://depot.dev" }
      : null,
  isChangeRequestInRepository: (identity, link) =>
    identity.canonicalKey === `${link.host}/${link.repository}`,
  canReadChangeRequestOnHost: (_identity, link) => link.host === "depot.dev",
});
