import cron from "node-cron";

type ScheduledTrigger = "startup" | "cron";

/**
 * Runs an async job on startup and on a cron schedule, with overlap protection.
 */
export class Scheduler {
  private readonly name: string;
  private readonly cronExpression: string;
  private readonly task: () => Promise<void>;
  private isRunning = false;

  /**
   * @param name - Human-friendly job name used in logs.
   * @param cronExpression - Cron expression from configuration.
   * @param task - Async job function to execute.
   */
  constructor({
    name,
    cronExpression = "0 */6 * * *", // every 6 hours
    task,
  }: {
    name: string,
    cronExpression: string,
    task: () => Promise<void>
  }) {
    this.name = name;
    this.task = task;
    if (!cron.validate(cronExpression)) {
      throw new Error(`Invalid cron expression for ${name}: "${cronExpression}".`);
    }
    this.cronExpression = cronExpression;

  }

  /** Starts the scheduled job and immediately executes one startup run. */
  public start(): void {
    void this.run("startup");
    cron.schedule(this.cronExpression, () => {
      void this.run("cron");
    });

    console.log(`Scheduled ${this.name} with cron: "${this.cronExpression}".`);
  }

  /**
   * Executes a task run for the given trigger while preventing overlaps.
   * @param trigger - Indicates startup or cron invocation source.
   */
  private async run(trigger: ScheduledTrigger): Promise<void> {
    if (this.isRunning) {
      console.log(`Skipping ${this.name} ${trigger} run — previous run still in progress.`);
      return;
    }

    this.isRunning = true;
    try {
      await this.task();
      console.log(`${this.name} complete (${trigger}).`);
    } catch (error) {
      console.error(`Error during ${this.name} (${trigger}):`, error);
    } finally {
      this.isRunning = false;
    }
  }
}
