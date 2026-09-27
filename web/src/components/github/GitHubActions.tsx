import { AnimatePresence } from "motion/react";
import { ResizeHandle } from "../ResizeHandle.tsx";
import { useEffect, useState } from "react";
import { ArrowLeft, Play, RefreshCw, Terminal } from "lucide-react";
import { useGitHub } from "../../lib/use-github.ts";
import { useI18n } from "../../lib/i18n.ts";
import { Select } from "../Select.tsx";
import { github } from "../../lib/actions.ts";
import {
  GitHubDialog,
  GitHubFeedback,
  GitHubLink,
  GitHubPagination,
  GitHubState,
  formText,
  githubDate,
} from "./GitHubShared.tsx";
import type {
  GitHubRepository,
  GitHubMutation,
} from "../../../../shared/github.ts";
import { SelectionHighlight } from "../SelectionHighlight.tsx";

export function GitHubActions({
  repository,
}: {
  repository: GitHubRepository;
}) {
  const t = useI18n();
  const repo = repository.full_name;
  const [inputs, setInputs] = useState([{ name: "", value: "" }]);
  const [page, setPage] = useState(1);
  const [branch, setBranch] = useState("");
  const [selected, setSelected] = useState<number | null>(null);
  const [jobId, setJobId] = useState<number | null>(null);
  const [action, setAction] = useState<"dispatch" | "rerun" | "cancel" | null>(
    null,
  );
  const [message, setMessage] = useState("");
  const list = useGitHub("runs", { repo, page, branch });
  const detail = useGitHub("run", selected ? { repo, id: selected } : null);
  const logs = useGitHub("logs", jobId ? { repo, jobId } : null);
  const workflows = useGitHub(
    "workflows",
    action === "dispatch" ? { repo } : null,
  );
  const branches = useGitHub("branches", { repo });
  const refresh = () => {
    list.refresh();
    if (selected) detail.refresh();
  };
  const active = detail.data?.run.status !== "completed";
  useEffect(() => {
    if (!list.data?.items.some((run) => run.status !== "completed")) return;
    let timer: ReturnType<typeof setInterval> | undefined;
    const resume = () => {
      clearInterval(timer);
      if (document.hidden) return;
      refresh();
      timer = setInterval(refresh, 20_000);
    };
    if (!document.hidden) timer = setInterval(refresh, 20_000);
    document.addEventListener("visibilitychange", resume);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [list.data, selected]);
  return (
    <div className="github-workspace">
      <div className="github-toolbar">
        <h2>{t("Workflow runs")}</h2>
        <Select
          aria-label={t("Workflow branch")}
          value={branch}
          onChange={(value) => {
            setBranch(value);
            setPage(1);
          }}
          options={[
            { value: "", label: t("All branches") },
            ...(branches.data ?? []).map((name) => ({ value: name, label: name })),
          ]}
        />
        <button
          className="icon-btn"
          aria-label={t("Refresh workflows")}
          onClick={refresh}
          disabled={list.loading}
        >
          <RefreshCw size={16} />
        </button>
        <button
          className="btn"
          data-variant="primary"
          disabled={!repository.permissions?.push || repository.archived}
          onClick={() => setAction("dispatch")}
        >
          <Play size={14} />
        {t("Run workflow")}
        </button>
      </div>
      {message && (
        <p className="github-notice" role="status">
          {message}
        </p>
      )}
      <div className="github-split" data-detail={Boolean(selected)}>
        <div className="github-list scroll sliding-selection">
          <SelectionHighlight value={selected === null ? undefined : String(selected)} selector='.github-item[aria-pressed="true"]' />
          <GitHubFeedback
            error={list.error}
            loading={list.loading && !list.data}
            empty={
              list.data?.items.length === 0 ? t("No workflow runs") : undefined
            }
          />
          {list.data?.items.map((run) => (
            <button
              key={run.id}
              className="github-item"
              aria-pressed={selected === run.id}
              onClick={() => {
                setSelected(run.id);
                setJobId(null);
              }}
            >
              <GitHubState state={run.conclusion ?? run.status} />
              <strong>{run.display_title}</strong>
              <span className="github-meta">
                {run.name} #{run.run_number}
              </span>
              <span className="github-meta">
                {run.head_branch} · {run.event} · {githubDate(run.created_at)}
              </span>
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
              <Play size={30} />
              <h2>{t("Select a workflow run")}</h2>
              <p>{" "}{t("Inspect jobs, steps, and logs. Active runs refresh automatically.")}{" "}</p>
            </div>
          ) : (
            <>
              <button
                className="btn github-detail-back"
                onClick={() => setSelected(null)}
              >
                <ArrowLeft size={15} />
                  {t("Back to runs")}
              </button>
              <GitHubFeedback
                error={detail.error}
                loading={detail.loading && !detail.data}
              />
              {detail.data && (
                <>
                  <header className="github-item-heading">
                    <GitHubState
                      state={
                        detail.data.run.conclusion ?? detail.data.run.status
                      }
                    />
                    <GitHubLink href={detail.data.run.html_url}>{" "}{t("Open on GitHub")}{" "}</GitHubLink>
                    <h2>{detail.data.run.display_title}</h2>
                    <p>
                      {detail.data.run.name} · {detail.data.run.head_branch} ·{" "}
                      {detail.data.run.head_sha.slice(0, 7)}{" "}{t("· Attempt")}{" "}
                      {detail.data.run.run_attempt}
                    </p>
                  </header>
                  <div className="github-detail-actions">
                    {repository.permissions?.push && (
                      <button
                        className="btn"
                        onClick={() => setAction(active ? "cancel" : "rerun")}
                      >
                          {active ? t("Cancel run…") : t("Re-run jobs…")}
                      </button>
                    )}
                  </div>
                  <div className="github-jobs">
                    {detail.data.jobs.map((job) => (
                      <details key={job.id} open>
                        <summary>
                          <GitHubState state={job.conclusion ?? job.status} />
                          <strong>{job.name}</strong>
                        </summary>
                        <ol>
                          {job.steps.map((step) => (
                            <li key={step.number}>
                              <GitHubState
                                state={step.conclusion ?? step.status}
                              />
                              <span>{step.name}</span>
                            </li>
                          ))}
                        </ol>
                        <button
                          className="btn"
                          onClick={() => setJobId(job.id)}
                        >
                          <Terminal size={14} />
                          {t("View logs")}
                        </button>
                      </details>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
      <AnimatePresence>{jobId && (
        <GitHubDialog
          title={t("Job logs")}
          description={t("{repository} · job {job}", { repository: repo, job: jobId })}
          onClose={() => setJobId(null)}
        >
          <GitHubFeedback error={logs.error} loading={logs.loading} />
          <button
            type="button"
            className="btn"
            onClick={logs.refresh}
            disabled={logs.loading}
          >
            {t("Refresh logs")}
          </button>
          <pre className="github-logs scroll">{logs.data}</pre>
        </GitHubDialog>
      )}</AnimatePresence>
      <AnimatePresence>{action && (
        <GitHubDialog
          title={
            action === "dispatch"
              ? t("Run a workflow")
              : action === "rerun"
                ? t("Re-run workflow jobs")
                : t("Cancel this run")
          }
          description={t("{target}. This action will be sent to GitHub.", { target: `${repo}${selected && action !== "dispatch" ? ` · ${detail.data?.run.name} #${detail.data?.run.run_number}` : ""}` })}
          submitLabel={
            action === "dispatch"
              ? t("Run workflow")
              : action === "rerun"
                ? t("Re-run jobs")
                : t("Cancel run")
          }
          danger={action === "cancel"}
          onClose={() => setAction(null)}
          onSubmit={async (data) => {
            let mutation: GitHubMutation;
            if (action === "dispatch") {
              const provided = inputs.filter((input) => input.name.trim());
              if (
                new Set(provided.map((input) => input.name.trim())).size !==
                provided.length
              )
                throw new Error(t("Each input needs a unique name."));
              if (!formText(data, "workflow"))
                throw new Error(t("Select a workflow"));
              mutation = {
                action: "dispatch",
                id: Number(formText(data, "workflow")),
                ref: formText(data, "ref"),
                inputs: Object.fromEntries(
                  provided.map((input) => [input.name.trim(), input.value]),
                ),
              };
            } else if (action === "rerun")
              mutation = {
                action: "rerun",
                id: selected!,
                failedOnly: data.has("failed"),
              };
            else mutation = { action: "cancelRun", id: selected! };
            setMessage((await github("mutate", { repo, mutation })).message);
            refresh();
          }}
        >
          {action === "dispatch" && (
            <>
              <GitHubFeedback
                error={workflows.error}
                loading={workflows.loading}
              />
              <label className="git-field">{" "}{t("Workflow")}{" "}<Select
                  name="workflow"
                  placeholder={t("Select a workflow")}
                  options={(workflows.data ?? [])
                    .filter((workflow) => workflow.state === "active")
                    .map((workflow) => ({ value: String(workflow.id), label: workflow.name }))}
                />
              </label>
              <label className="git-field">{" "}{t("Branch or tag")}{" "}<input
                  name="ref"
                  defaultValue={repository.default_branch}
                  required
                />
              </label>
              <div className="github-workflow-inputs">
                <h3>{t("Workflow inputs")}</h3>
                <p className="github-meta">{" "}{t("Optional values defined by this workflow.")}{" "}</p>
                {inputs.map((input, index) => (
                  <div className="github-form-columns" key={index}>
                    <label className="git-field">{" "}{t("Input name")}{" "}<input
                        value={input.name}
                        onChange={(event) =>
                          setInputs((rows) =>
                            rows.map((row, i) =>
                              i === index
                                ? { ...row, name: event.target.value }
                                : row,
                            ),
                          )
                        }
                        placeholder={t("environment")}
                      />
                    </label>
                    <label className="git-field">{" "}{t("Value")}{" "}<input
                        value={input.value}
                        onChange={(event) =>
                          setInputs((rows) =>
                            rows.map((row, i) =>
                              i === index
                                ? { ...row, value: event.target.value }
                                : row,
                            ),
                          )
                        }
                        placeholder={t("staging")}
                      />
                    </label>
                  </div>
                ))}
                <button
                  className="btn"
                  type="button"
                  disabled={inputs.length >= 25}
                  onClick={() =>
                    setInputs((rows) => [...rows, { name: "", value: "" }])
                  }
                >
                  {t("Add input")}
                </button>
              </div>
            </>
          )}
          {action === "rerun" && (
            <label className="github-checkbox">
              <input
                type="checkbox"
                name="failed"
                defaultChecked={detail.data?.run.conclusion === "failure"}
              />
                {t("Only re-run failed jobs")}
            </label>
          )}
        </GitHubDialog>
      )}</AnimatePresence>
    </div>
  );
}
