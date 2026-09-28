import { GitBranch, RefreshCw } from "lucide-react";
import { shortPath } from "../../lib/format.ts";
import { useI18n } from "../../lib/i18n.ts";
import { workingLabels, type Section } from "./labels.ts";
import { PixelLoader } from "../PixelLoader.tsx";
import type {
  GitOperation,
  GitOverview,
} from "../../../../shared/protocol.ts";

export function GitHeader({
  section,
  busy,
  notice,
  path,
  home,
  data,
  branch,
  upstream,
  refreshDisabled,
  onRefresh,
}: {
  section: Section;
  busy: GitOperation | null;
  notice?: string;
  path?: string;
  home: string;
  data: GitOverview | null;
  branch: string;
  upstream?: string;
  refreshDisabled: boolean;
  onRefresh: () => void;
}) {
  const t = useI18n();
  return (
    <header className="git-header">
      <div className="git-heading">
        <div>
          <h1>{t(section)}</h1>
          <p role="status" title={path}>
            {busy
              ? `${t(workingLabels[busy] ?? "Working")}…`
              : notice
                ? notice
                : path
              ? shortPath(path, home)
              : t("No workspace selected")}
          </p>
        </div>
      </div>
      <div className="git-repository-state">
        {data?.repository && (
          <div className="git-current-branch">
            <GitBranch size={16} />
            <strong>
              {branch === "detached" ? t("Detached HEAD") : branch}
            </strong>
            <span>
              {!data.hasCommits
                ? t("No commits yet")
                : upstream
                  ? data.status?.ahead || data.status?.behind
                    ? t("{ahead} ahead · {behind} behind", { ahead: data.status?.ahead ?? 0, behind: data.status?.behind ?? 0 })
                    : t("Up to date")
                  : t("Local branch")}
            </span>
          </div>
        )}
        <button
          className="icon-btn"
          title={t("Refresh repository")}
          disabled={refreshDisabled}
          onClick={onRefresh}
        >
          {busy === "overview" ? <PixelLoader size={17} /> : <RefreshCw size={17} />}
        </button>
      </div>
    </header>
  );
}
