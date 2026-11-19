// Cloudflare Workflows integration for school-status-bot.
//
// Provides durable multi-step execution with automatic state checkpointing
// and pause/resume capability across hours (using step.sleep and step.do).
// Used during severe winter storm warnings and early morning closure windows
// (4:30 AM to 7:30 AM Eastern) to guarantee persistent watchdog scans
// without consuming active CPU time during wait periods.

let WorkflowEntrypointBase = class {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
};

try {
  const cfWorkers = await import('cloudflare:workers');
  if (cfWorkers?.WorkflowEntrypoint) {
    WorkflowEntrypointBase = cfWorkers.WorkflowEntrypoint;
  }
} catch {
  // Graceful fallback for local Node.js testing environment
}

export class StormWatchdogWorkflow extends WorkflowEntrypointBase {
  /**
   * Executes the multi-step storm watchdog workflow.
   *
   * @param {object} event - Workflow invocation event
   * @param {object} step - Workflow step controller (step.do, step.sleep)
   */
  async run(event, step) {
    const env = this.env;

    // Step 1: Initial status verification
    const initialCheck = await step.do('check-initial-storm-status', async () => {
      const { doCheckAndPost } = await import('./check.js');
      return await doCheckAndPost(env, { source: 'storm-workflow-1' });
    });

    // If an announcement was already detected, finish workflow early
    if (initialCheck && !initialCheck.skipped) {
      return { completed: true, stage: 'initial', result: initialCheck };
    }

    // Step 2: Sleep for 10 minutes (zero CPU usage during sleep)
    await step.sleep('wait-next-storm-scan', '10 minutes');

    // Step 3: Follow-up watchdog check
    const followUpCheck = await step.do('check-followup-storm-status', async () => {
      const { doCheckAndPost } = await import('./check.js');
      return await doCheckAndPost(env, { source: 'storm-workflow-2' });
    });

    return { completed: true, stage: 'followup', result: followUpCheck };
  }
}

/**
 * Triggers the durable storm watchdog workflow if the STORM_WORKFLOW binding exists.
 *
 * @param {object} env
 * @param {object} params
 * @returns {Promise<string|null>} Workflow instance ID or null
 */
export async function triggerStormWatchdogWorkflow(env, params = {}) {
  if (!env || !env.STORM_WORKFLOW || typeof env.STORM_WORKFLOW.create !== 'function') {
    return null;
  }

  try {
    const instanceId = `storm_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const instance = await env.STORM_WORKFLOW.create({
      id: instanceId,
      params
    });
    return instance?.id || instanceId;
  } catch (err) {
    console.warn('Failed to launch storm watchdog workflow:', err && err.message ? err.message : err);
    return null;
  }
}
