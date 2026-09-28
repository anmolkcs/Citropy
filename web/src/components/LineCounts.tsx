export function LineCounts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="line-counts">
      <span className="diff-plus">+{added}</span>
      <span className="diff-minus">-{removed}</span>
    </span>
  );
}
