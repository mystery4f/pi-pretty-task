/**
 * pi-pretty-task — background processes and scheduled agent wake-ups for pi.
 *
 * One store owns every Task of a session; the tools are the agent's way in.
 * The panel and the loops join the same store as their tickets land.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ProcessTasks } from "./tasks/process/process-tasks.js";
import { processTaskTools } from "./tasks/process/tools.js";
import {
  notifyTaskFinished,
  renderTaskFinished,
  TASK_FINISHED_CUSTOM_TYPE,
} from "./ui/notification.js";
import { registerTasksCommand } from "./ui/tasks-command.js";

/** Extension entry: register this package's tools and commands on the running pi. */
export default function extension(pi: ExtensionAPI): void {
  const processTasks = new ProcessTasks({
    // The store does not await the announcement; a notice outlives the task.
    onFinish: (view) => {
      void notifyTaskFinished(pi, view);
    },
  });
  pi.registerMessageRenderer(TASK_FINISHED_CUSTOM_TYPE, renderTaskFinished);
  for (const tool of processTaskTools(processTasks)) pi.registerTool(tool);
  registerTasksCommand(pi, processTasks);
}
