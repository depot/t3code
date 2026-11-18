import * as Schema from "effect/Schema";

export const Repository = Schema.Struct({
  repositoryId: Schema.String,
  name: Schema.String,
  defaultBranch: Schema.String,
  cloneUrl: Schema.String,
});

export function repositorySelector(value: string) {
  if (URL.canParse(value)) {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash
    )
      return null;
    const page =
      url.hostname === "depot.dev"
        ? /^\/orgs\/([a-z0-9]+)\/code\/repositories\/([a-z0-9]+)\/?$/u.exec(url.pathname)
        : null;
    if (page) return { org: page[1]!, args: ["--id", page[2]!] };
    const host = /^([a-z0-9]+)\.code\.depot\.dev$/u.exec(url.hostname);
    return host ? { org: host[1]!, args: ["--remote", value] } : null;
  }
  const match = /^([a-z0-9]+)\/(.+)$/u.exec(value);
  if (match) return { org: match[1]!, args: ["--", match[2]!] };
  return value && !/[\s/\\:]/u.test(value) ? { org: null, args: ["--", value] } : null;
}

export function cloneUrls(repo: typeof Repository.Type, org: string) {
  // Depot's repository API exposes HTTPS transport only.
  return { nameWithOwner: `${org}/${repo.name}`, url: repo.cloneUrl, sshUrl: repo.cloneUrl };
}

export function remoteArgument(value: string) {
  if (!URL.canParse(value)) return value.replace(/^[^@]+@/u, "git@");
  const url = new URL(value);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}
