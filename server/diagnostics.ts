import { dev } from "./config.ts";
import { cpus, freemem, totalmem, loadavg } from "node:os";
import { desktopRequest } from "./desktop.ts";
import { store } from "./store.ts";
import { panelList } from "./panels.ts";
import { browserStates } from "./browser.ts";
import { servicePid } from "./terminals.ts";
import { descendants, processTable } from "./process-table.ts";
import { protocolLog } from "./providers/events.ts";
import type { DiagnosticReport } from "../shared/features.ts";

export async function diagnostics(): Promise<DiagnosticReport> {
  const memory = process.memoryUsage();
  let processes: DiagnosticReport["processes"] = [];
  if (process.platform !== "win32") {
    const all = await processTable();
    const terminalPid = servicePid();
    const included = descendants(all, [process.pid, ...(terminalPid ? [terminalPid] : [])]);
    processes = all
      .filter((entry) => included.has(entry.pid))
      .sort((a, b) => b.cpu - a.cpu);
  }
  const desktop = await desktopRequest<DiagnosticReport["processes"]>(
    "diagnostics",
  ).catch(() => []);
  const allProcesses = new Map(processes.map((entry) => [entry.pid, entry]));
  for (const entry of desktop) allProcesses.set(entry.pid, entry);
  const cpu = process.cpuUsage();
  if (!allProcesses.has(process.pid))
    allProcesses.set(process.pid, {
      pid: process.pid,
      parent: process.ppid,
      name: "Citropy server",
      cpu: (cpu.user + cpu.system) / Math.max(process.uptime(), 1) / 10000,
      memory: memory.rss,
    });
  processes = [...allProcesses.values()].sort((a, b) => b.cpu - a.cpu);
  return {
    ...(dev ? { protocol: protocolLog() } : {}),
    sampledAt: Date.now(),
    uptime: process.uptime(),
    system: {
      memoryTotal: totalmem(),
      memoryFree: freemem(),
      cores: cpus().length,
      load: loadavg(),
    },
    server: {
      pid: process.pid,
      rss: memory.rss,
      heapUsed: memory.heapUsed,
      heapTotal: memory.heapTotal,
    },
    processes,
    conversations: store.threads.size,
    running: [...store.threads.values()].filter((thread) => thread.running)
      .length,
    terminals: panelList().filter((panel) => panel.kind === "terminal").length,
    browsers: browserStates().length,
  };
}
