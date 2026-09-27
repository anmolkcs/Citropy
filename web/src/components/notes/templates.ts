import { Bug, FileText, Lightbulb, ListChecks, NotebookPen, SearchCheck, Target, Users } from "lucide-react";
import type { Translator } from "../../lib/translations.ts";

export interface NoteTemplate {
  id: string;
  label: string;
  hint: string;
  icon: typeof FileText;
  title: string;
  body: string;
}

const sections = (...headings: Array<[heading: string, start: string]>) =>
  headings.map(([heading, start]) => `## ${heading}\n${start}`).join("\n\n");

export function noteTemplates(t: Translator): NoteTemplate[] {
  return [
    { id: "blank", label: t("Blank note"), hint: t("Start from an empty page"), icon: NotebookPen, title: "", body: "" },
    {
      id: "brief",
      label: t("Task brief"),
      hint: t("Tell the agent what to build and when it's done"),
      icon: Target,
      title: t("Task brief"),
      body: sections([t("Goal"), ""], [t("Context"), ""], [t("Constraints"), "- "], [t("Done when"), "- [ ] "]),
    },
    {
      id: "bug",
      label: t("Bug report"),
      hint: t("What broke, what you expected, how to repeat it"),
      icon: Bug,
      title: t("Bug report"),
      body: sections([t("What happened"), ""], [t("What I expected"), ""], [t("Steps to reproduce"), "1. "], [t("Where"), "- "]),
    },
    {
      id: "idea",
      label: t("Feature idea"),
      hint: t("The problem, the idea, the open questions"),
      icon: Lightbulb,
      title: t("Feature idea"),
      body: sections([t("Problem"), ""], [t("Idea"), ""], [t("Open questions"), "- "]),
    },
    {
      id: "todo",
      label: t("To-do list"),
      hint: t("A checklist you can tick off"),
      icon: ListChecks,
      title: t("To do"),
      body: "- [ ] ",
    },
    {
      id: "review",
      label: t("Review notes"),
      hint: t("Things to check and change in a diff"),
      icon: SearchCheck,
      title: t("Review notes"),
      body: sections([t("Check"), "- [ ] "], [t("Concerns"), "- "], [t("Suggestions"), "- "]),
    },
    {
      id: "meeting",
      label: t("Meeting notes"),
      hint: t("Who was there, what was decided, who does what"),
      icon: Users,
      title: t("Meeting notes"),
      body: sections([t("Attendees"), "- "], [t("Notes"), ""], [t("Decisions"), "- "], [t("Action items"), "- [ ] "]),
    },
  ];
}
