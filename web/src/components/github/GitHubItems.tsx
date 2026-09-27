import { AnimatePresence } from "motion/react";
import { ResizeHandle } from "../ResizeHandle.tsx";
import { useState } from "react";
import {
  ArrowLeft,
  Check,
  MessageSquare,
  Plus,
  RefreshCw,
  Search,
} from "lucide-react";
import { useGitHub } from "../../lib/use-github.ts";
import { useI18n } from "../../lib/i18n.ts";
import { Select } from "../Select.tsx";
import {
  GitHubFeedback,
  GitHubPagination,
  GitHubState,
  githubDate,
} from "./GitHubShared.tsx";
import { GitHubItemDetail, githubItemState } from "./GitHubItemDetail.tsx";
import { GitHubItemDialog, type ItemAction } from "./GitHubItemDialog.tsx";
import type { GitHubRepository } from "../../../../shared/github.ts";
import { SelectionHighlight } from "../SelectionHighlight.tsx";

export function GitHubItems({
  repository,
  pull,
  branch,
  currentUser,
}: {
  repository: GitHubRepository;
  pull: boolean;
  branch?: string;
  currentUser: string;
}) {
  const t = useI18n();
  const repo = repository.full_name;
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [state, setState] = useState<"open" | "closed" | "all">("open");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<number | null>(null);
  const [tab, setTab] = useState("Conversation");
  const [action, setAction] = useState<ItemAction | null>(null);
  const [feedback, setFeedback] = useState("");
  const list = useGitHub("items", { repo, pull, state, query: search, page });
  const detail = useGitHub(
    "detail",
    selected ? { repo, pull, number: selected } : null,
  );
  const item = detail.data?.item;
  const refresh = () => {
    list.refresh();
    if (selected) detail.refresh();
  };
  return (
    <div className="github-workspace">
      <div className="github-toolbar">
        <form
          className="github-search"
          onSubmit={(event) => {
            event.preventDefault();
            setSearch(query);
            setPage(1);
          }}
        >
          <Search size={16} />
          <input
            aria-label={pull ? t("Search pull requests") : t("Search issues")}
            placeholder={pull ? t("Search pull requests…") : t("Search issues…")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
            <button className="btn" type="submit">
            {t("Search")}
          </button>
        </form>
        <Select
          aria-label={t("State")}
          value={state}
          onChange={(value) => {
            setState(value as typeof state);
            setPage(1);
          }}
          options={[
            { value: "open", label: t("Open") },
            { value: "closed", label: t("Closed") },
            { value: "all", label: t("All states") },
          ]}
        />
        <button
          className="icon-btn"
          onClick={refresh}
          title={t("Refresh")}
          aria-label={t("Refresh items")}
          disabled={list.loading}
        >
          <RefreshCw size={16} />
        </button>
        <button
          className="btn"
          data-variant="primary"
          onClick={() => setAction("new")}
          disabled={repository.archived}
        >
          <Plus size={15} />
          {pull ? t("New pull request") : t("New issue")}
        </button>
      </div>
      {feedback && (
        <div className="github-notice" role="status">
          <Check size={16} />
          {feedback}
        </div>
      )}
      <div className="github-split" data-detail={Boolean(selected)}>
        <div className="github-list scroll sliding-selection">
          <SelectionHighlight value={selected === null ? undefined : String(selected)} selector='.github-item[aria-pressed="true"]' />
          <div className="github-list-caption">
            {list.data?.total ?? ""} {pull ? t("pull requests") : t("issues")}
          </div>
          <GitHubFeedback
            error={list.error}
            loading={list.loading && !list.data}
            empty={
              list.data?.items.length === 0
                ? t("No {state} {items}", { state: state === "all" ? "" : t(state === "open" ? "open" : "closed"), items: pull ? t("pull requests") : t("issues") })
                : undefined
            }
          />
          {list.data?.items.map((entry) => (
            <button
              key={entry.id}
              className="github-item"
              aria-pressed={selected === entry.number}
              onClick={() => {
                setSelected(entry.number);
                setTab("Conversation");
              }}
            >
              <GitHubState state={githubItemState(entry)} pull={pull} />
              <strong>{entry.title}</strong>
              <span className="github-meta">
                #{entry.number} · {entry.user?.login ?? t("Deleted user")} ·{" "}
                {githubDate(entry.updated_at)}
              </span>
              <div className="github-labels">
                {entry.labels.slice(0, 3).map((label) => (
                  <span key={label.name}>{label.name}</span>
                ))}
              </div>
            </button>
          ))}
          {list.data && (
            <GitHubPagination
              page={page}
              more={list.data.more}
              onChange={setPage}
            />
          )}
        </div>
        <ResizeHandle panel="github" inline />
        <div className="github-detail scroll">
          {!selected ? (
            <div className="github-empty">
              <MessageSquare size={30} />
          <h2>{t("Select {item}", { item: pull ? t("a pull request") : t("an issue") })}</h2>
              <p>
                {t("Read the conversation, review changes, and follow its progress here.")}
              </p>
            </div>
          ) : (
            <>
              <button
                className="btn github-detail-back"
                onClick={() => setSelected(null)}
              >
                <ArrowLeft size={15} />
                {t("Back to {items}", { items: pull ? t("pull requests") : t("issues") })}
              </button>
              <GitHubFeedback
                error={detail.error}
                loading={detail.loading && !detail.data}
              />
              {detail.data && (
                <GitHubItemDetail
                  repository={repository}
                  pull={pull}
                  currentUser={currentUser}
                  detail={detail.data}
                  tab={tab}
                  onTab={setTab}
                  onAction={setAction}
                />
              )}
            </>
          )}
        </div>
      </div>
      <AnimatePresence>{action && (
        <GitHubItemDialog
          action={action}
          repository={repository}
          pull={pull}
          selected={selected}
          item={item}
          branch={branch}
          onClose={() => setAction(null)}
          onSaved={(message) => {
            setFeedback(message);
            refresh();
          }}
        />
      )}</AnimatePresence>
    </div>
  );
}
