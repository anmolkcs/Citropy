export function withSkills(text: string, skills: Array<{ name: string; path: string }>): string {
  if (!skills.length) return text;
  const instructions = skills.map((skill) => `Use the ${skill.name} skill. Read its instructions at ${skill.path}.`).join("\n");
  return /^\/[\w.:-]+(?:\s|$)/.test(text.trim()) ? `${text}\n\n${instructions}` : `${instructions}\n\n${text}`;
}
