import { QuestionHistory } from "./parts/QuestionHistory.tsx";
import { memo } from "react";
import { Prose } from "./parts/Prose.tsx";
import { Reasoning } from "./parts/Reasoning.tsx";
import { ToolCard } from "./parts/ToolCard.tsx";
import { TodoBoard } from "./parts/TodoBoard.tsx";
import { Notice } from "./parts/Notice.tsx";
import { ImageGallery } from "./parts/ImageGallery.tsx";
import { useApp } from "../lib/store.ts";

interface Props {
  partId: string;
  live: boolean;
}

export const PartView = memo(function PartView({ partId, live }: Props) {
  const part = useApp((state) => state.parts.get(partId));
  if (!part) return null;

  switch (part.kind) {
    case "text":
      return <Prose partId={part.id} text={part.text} live={live && part.complete !== true} />;
    case "reasoning":
      return <Reasoning ids={[part.id]} live={live} />;
    case "tool":
      return <ToolCard part={part} />;
    case "todo":
      return <TodoBoard partId={part.id} items={part.items} />;
    case "question":
      return <QuestionHistory part={part} />;
    case "images":
      return <ImageGallery part={part} />;
    case "notice":
      return <Notice level={part.level} text={part.text} />;
    default:
      return null;
  }
});
