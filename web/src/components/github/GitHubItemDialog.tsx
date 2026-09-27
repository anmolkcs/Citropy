import { useGitHub } from "../../lib/use-github.ts";
import { useI18n } from "../../lib/i18n.ts";
import { Select } from "../Select.tsx";
import { github } from "../../lib/actions.ts";
import {
  GitHubDialog,
  GitHubFeedback,
  formNames,
  formText,
} from "./GitHubShared.tsx";
import type {
  GitHubRepository,
  GitHubItem,
  GitHubMutation,
} from "../../../../shared/github.ts";

export type ItemAction =
  | "new"
  | "edit"
  | "comment"
  | "state"
  | "review"
  | "merge"
  | "ready"
  | "reviewers";

function itemMutation(
  action: ItemAction,
  data: FormData,
  pull: boolean,
  number: number,
  item: GitHubItem | undefined,
): GitHubMutation {
  switch (action) {
    case "new":
      return pull
        ? {
            action: "createPull",
            title: formText(data, "title"),
            body: formText(data, "body"),
            head: formText(data, "head"),
            base: formText(data, "base"),
            draft: data.has("draft"),
          }
        : {
            action: "createIssue",
            title: formText(data, "title"),
            body: formText(data, "body"),
            labels: formNames(data, "labels"),
            assignees: formNames(data, "assignees"),
          };
    case "edit":
      return {
        action: "editItem",
        number,
        title: formText(data, "title"),
        body: formText(data, "body"),
        labels: formNames(data, "labels"),
        assignees: formNames(data, "assignees"),
      };
    case "comment":
      return { action: "comment", number, body: formText(data, "body") };
    case "state":
      return {
        action: "state",
        number,
        pull,
        state: item?.state === "open" ? "closed" : "open",
      };
    case "review":
      return {
        action: "review",
        number,
        body: formText(data, "body"),
        event: formText(data, "event") as
          | "APPROVE"
          | "REQUEST_CHANGES"
          | "COMMENT",
        sha: item?.head?.sha ?? "",
      };
    case "merge":
      return {
        action: "merge",
        number,
        method: formText(data, "method") as "squash" | "merge" | "rebase",
        sha: item?.head?.sha ?? "",
      };
    case "ready":
      return { action: "ready", number };
    case "reviewers":
      return {
        action: "requestReview",
        number,
        reviewers: formNames(data, "reviewers"),
      };
  }
}

export function GitHubItemDialog({
  action,
  repository,
  pull,
  selected,
  item,
  branch,
  onClose,
  onSaved,
}: {
  action: ItemAction;
  repository: GitHubRepository;
  pull: boolean;
  selected: number | null;
  item: GitHubItem | undefined;
  branch?: string;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const t = useI18n();
  const repo = repository.full_name;
  const branches = useGitHub(
    "branches",
    action === "new" && pull ? { repo } : null,
  );
  const titles: Record<ItemAction, string> = {
    new: pull ? t("New pull request") : t("New issue"),
    edit: t("Edit details"),
    comment: t("Add a comment"),
    state: item?.state === "open" ? t("Close on GitHub") : t("Reopen on GitHub"),
    review: t("Submit a review"),
    merge: t("Merge pull request"),
    ready: t("Mark ready for review"),
    reviewers: t("Request a review"),
  };
  const submit = async (data: FormData) => {
    const mutation = itemMutation(action, data, pull, selected ?? 0, item);
    const result = await github("mutate", { repo, mutation });
    onSaved(result.message);
  };
  return (
    <GitHubDialog
      title={titles[action]}
      description={`${repo}${selected && action !== "new" ? ` · #${selected}` : ""}. ${action === "merge" ? t("Merge the reviewed commit into the base branch. GitHub branch protections still apply.") : action === "new" && pull ? t("Both branches must already be pushed to GitHub.") : t("Changes will be saved to GitHub under your signed-in account.")}`}
      submitLabel={
        action === "new"
          ? pull
            ? t("Create pull request")
            : t("Create issue")
          : titles[action]
      }
      danger={action === "state" && item?.state === "open"}
      onClose={onClose}
      onSubmit={submit}
    >
      {(action === "new" || action === "edit") && (
        <label className="git-field">{" "}{t("Title")}{" "}<input
            name="title"
            defaultValue={action === "edit" ? item?.title : ""}
            required
            maxLength={256}
          />
        </label>
      )}
      {action === "new" && pull && (
        <>
          <GitHubFeedback error={branches.error} />
          <div className="github-form-columns">
            <label className="git-field">{" "}{t("Head branch")}{" "}<input
                name="head"
                list="github-branches"
                defaultValue={
                  branch && branch !== repository.default_branch
                    ? branch
                    : ""
                }
                placeholder={t("feature/my-change or owner:branch")}
                required
              />
            </label>
            <label className="git-field">{" "}{t("Base branch")}{" "}<input
                name="base"
                list="github-branches"
                defaultValue={repository.default_branch}
                required
              />
            </label>
          </div>
          <datalist id="github-branches">
            {branches.data?.map((name) => (
              <option key={name} value={name} />
            ))}
          </datalist>
          <label className="github-checkbox">
            <input type="checkbox" name="draft" defaultChecked />{" "}{t("Create as a draft")}{" "}</label>
        </>
      )}
      {action === "review" && (
        <label className="git-field">{" "}{t("Review decision")}{" "}<Select
            name="event"
            defaultValue="COMMENT"
            options={[
              { value: "COMMENT", label: t("Comment") },
              { value: "APPROVE", label: t("Approve") },
              { value: "REQUEST_CHANGES", label: t("Request changes") },
            ]}
          />
        </label>
      )}
      {["new", "edit", "comment", "review"].includes(action) && (
        <label className="git-field">
          {action === "comment" || action === "review"
            ? t("Comment")
            : t("Description")}
          <textarea
            name="body"
            rows={6}
            defaultValue={action === "edit" ? (item?.body ?? "") : ""}
            required={action === "comment"}
            placeholder={t("Markdown supported")}
          />
        </label>
      )}
      {(action === "edit" || (action === "new" && !pull)) && (
        <div className="github-form-columns">
          <label className="git-field">{" "}{t("Labels")}{" "}<input
              name="labels"
              defaultValue={
                action === "edit"
                  ? item?.labels.map((label) => label.name).join(", ")
                  : ""
              }
              placeholder={t("bug, documentation")}
            />
          </label>
          <label className="git-field">{" "}{t("Assignees")}{" "}<input
              name="assignees"
              defaultValue={
                action === "edit"
                  ? item?.assignees.map((user) => user.login).join(", ")
                  : ""
              }
              placeholder={t("usernames, separated by commas")}
            />
          </label>
        </div>
      )}
      {action === "reviewers" && (
        <label className="git-field">{" "}{t("Reviewers")}{" "}<input
            name="reviewers"
            required
            placeholder={t("usernames, separated by commas")}
          />
        </label>
      )}
      {action === "merge" && (
        <label className="git-field">{" "}{t("Merge method")}{" "}<Select
            name="method"
            defaultValue={
              repository.allow_squash_merge
                ? "squash"
                : repository.allow_merge_commit
                  ? "merge"
                  : "rebase"
            }
            options={[
              ...repository.allow_squash_merge ? [{ value: "squash", label: t("Squash and merge") }] : [],
              ...repository.allow_merge_commit ? [{ value: "merge", label: t("Create a merge commit") }] : [],
              ...repository.allow_rebase_merge ? [{ value: "rebase", label: t("Rebase and merge") }] : [],
            ]}
          />
          <small>{" "}{t("Commit")}{" "}{item?.head?.sha.slice(0, 12)}{" "}{t("into")}{" "}{item?.base?.ref}
          </small>
        </label>
      )}
    </GitHubDialog>
  );
}
