import cron from "node-cron";

type ScheduledTrigger = "startup" | "cron";

/**
 * Runs an async job on startup and on a cron schedule, with overlap protection.
 */
export class Scheduler {
  private readonly name: string;
  private readonly cronExpression: string;
  private readonly defaultCronExpression: string;
  private readonly task: () => Promise<void>;
  private isRunning = false;

  /**
   * @param name - Human-friendly job name used in logs.
   * @param cronExpression - Cron expression from configuration.
   * @param defaultCronExpression - Fallback cron expression when input is invalid.
   * @param task - Async job function to execute.
   */
  constructor(
    name: string,
    cronExpression: string,
    defaultCronExpression: string,
    task: () => Promise<void>
  ) {
    this.name = name;
    this.cronExpression = cronExpression;
    this.defaultCronExpression = defaultCronExpression;
    this.task = task;
  }

  /** Starts the scheduled job and immediately executes one startup run. */
  public start(): void {
    void this.run("startup");

    const activeCron = this.resolveCronExpression();
    cron.schedule(activeCron, () => {
      void this.run("cron");
    });

    console.log(`Scheduled ${this.name} with cron: "${activeCron}".`);
  }

  /** Resolves the active cron expression, falling back when configured input is invalid. */
  private resolveCronExpression(): string {
    if (cron.validate(this.cronExpression)) {
      return this.cronExpression;
    }

    console.warn(
      `Invalid cron expression for ${this.name}: "${this.cronExpression}", falling back to "${this.defaultCronExpression}".`
    );
    return this.defaultCronExpression;
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
