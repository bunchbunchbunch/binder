// One-line description of a tool call, like Claude Code's own "⏺ Bash(npm test)".
export function toolSummary(name: string, input: unknown, inputJson: string): string {
  let args: Record<string, unknown> = {};
  if (input && typeof input === 'object' && Object.keys(input as object).length) {
    args = input as Record<string, unknown>;
  } else if (inputJson) {
    try {
      args = JSON.parse(inputJson);
    } catch {
      return `${name}(${inputJson.slice(0, 60)}…)`;
    }
  }
  const pick = (...keys: string[]) => {
    for (const k of keys) {
      const v = args[k];
      if (typeof v === 'string' && v.trim()) return v;
    }
    return undefined;
  };
  let arg = pick('command', 'file_path', 'pattern', 'description', 'prompt', 'query', 'url', 'skill', 'path');
  if (arg === undefined) {
    const firstString = Object.values(args).find((v) => typeof v === 'string') as string | undefined;
    arg = firstString;
  }
  if (arg === undefined) return name;
  const oneLine = arg.replace(/\s+/g, ' ').trim();
  return `${name}(${oneLine.length > 80 ? oneLine.slice(0, 79) + '…' : oneLine})`;
}
